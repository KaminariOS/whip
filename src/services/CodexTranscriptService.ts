import type { NativeAgentTranscriptState, NativeAgentTranscriptUpdate } from 'react-native-whip-ssh';

import type { AgentChatState } from '../agentChat';
import { agentChatStateFromNative, applyNativeAgentTranscriptUpdate } from '../lib/nativeAgentTranscript';
import { agentChatCache, type AgentChatCache, type AgentChatCacheKey } from './agentChatCache';

export interface NativeTranscriptTransport {
  startAgentTranscript(
    terminalId: string,
    key: string,
    cacheBlob: ArrayBuffer | undefined,
  ): NativeAgentTranscriptState;
  agentTranscript(key: string): NativeAgentTranscriptState;
  closeAgentTranscriptTerminal(terminalId: string): string | undefined;
  confirmAgentTranscriptCache(confirmationToken: string): boolean;
}

export interface CodexTranscriptTransport extends NativeTranscriptTransport {
  bindCodexAgentTranscript(
    terminalId: string,
    sessionId: string,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState };
}

type Listener = (state: AgentChatState) => void;

interface TranscriptEntry<Transport extends NativeTranscriptTransport> {
  nativeKey: string;
  cacheKey: AgentChatCacheKey;
  hostSessionId: string;
  sessionId: string;
  transport: Transport;
  listeners: Set<Listener>;
  state: AgentChatState;
  persistChain: Promise<void>;
}

function transcriptKey(hostSessionId: string, nativeKey: string): string {
  return `${hostSessionId}\n${nativeKey}`;
}

/** Agent-neutral UI/listener and opaque-storage facade over Rust AgentSessionManager. */
export class NativeTranscriptService<Transport extends NativeTranscriptTransport> {
  private readonly entries = new Map<string, TranscriptEntry<Transport>>();

  constructor(
    private readonly agent: AgentChatCacheKey['agent'],
    private readonly bindNative: (
      transport: Transport,
      terminalId: string,
      sessionId: string,
      handler: (event: NativeAgentTranscriptUpdate) => void,
    ) => { key: string; state: NativeAgentTranscriptState },
    private readonly cache: AgentChatCache = agentChatCache,
  ) {}

  activate(
    hostProfileId: string,
    hostSessionId: string,
    terminalId: string,
    sessionId: string,
    transport: Transport,
  ): string {
    let boundEntry: TranscriptEntry<Transport> | undefined;
    const result = this.bindNative(
      transport,
      terminalId,
      sessionId,
      event => boundEntry && this.acceptEvent(boundEntry, event),
    );
    const key = transcriptKey(hostSessionId, result.key);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        nativeKey: result.key,
        cacheKey: { hostProfileId, agent: this.agent, sessionId },
        hostSessionId,
        sessionId,
        transport,
        listeners: new Set(),
        state: agentChatStateFromNative(result.state),
        persistChain: Promise.resolve(),
      };
      this.entries.set(key, entry);
      boundEntry = entry;
      this.restoreAndStart(entry, terminalId);
    } else {
      entry.transport = transport;
      entry.sessionId = sessionId;
      boundEntry = entry;
      this.startNative(entry, terminalId, undefined);
    }
    return key;
  }

  subscribe(key: string, listener: Listener): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    listener(entry.state);
    return () => entry.listeners.delete(listener);
  }

  getState(key: string): AgentChatState | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return entry.state;
  }

  hasCachedHistory(key: string): boolean {
    const status = this.entries.get(key)?.state.status;
    return status === 'live' || status === 'stale';
  }

  closeTerminal(hostSessionId: string, terminalId: string, projectionKey?: string): void {
    const transport = [...this.entries.values()]
      .find(entry => entry.hostSessionId === hostSessionId)?.transport;
    const released = transport?.closeAgentTranscriptTerminal(terminalId);
    const key = projectionKey ?? (released ? transcriptKey(hostSessionId, released) : null);
    if (!key) return;
    this.entries.get(key)?.listeners.clear();
    this.entries.delete(key);
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      entry.listeners.clear();
    }
    this.entries.clear();
  }

  private restoreAndStart(entry: TranscriptEntry<Transport>, terminalId: string): void {
    this.cache.loadNative(entry.cacheKey).then(blob => {
      this.startNative(entry, terminalId, blob || undefined);
    }).catch(error => {
      this.publish(entry, { ...entry.state, status: 'error', error: String(error) });
      this.startNative(entry, terminalId, undefined);
    });
  }

  private startNative(entry: TranscriptEntry<Transport>, terminalId: string, cacheBlob: ArrayBuffer | undefined): void {
    try {
      this.acceptState(entry, entry.transport.startAgentTranscript(
        terminalId,
        entry.nativeKey,
        cacheBlob,
      ));
    } catch (error) {
      // Rust rejects a late cache load when the terminal was rebound. That is
      // expected lifecycle protection, not a visible transcript failure.
      if (/StaleGeneration|no longer bound/i.test(String(error))) return;
      this.publish(entry, { ...entry.state, status: 'error', error: String(error) });
    }
  }

  private acceptEvent(entry: TranscriptEntry<Transport>, event: NativeAgentTranscriptUpdate): void {
    if (event.key !== entry.nativeKey) return;
    const next = applyNativeAgentTranscriptUpdate(entry.state, event);
    if (next === null) {
      try {
        this.acceptState(entry, entry.transport.agentTranscript(event.key));
      } catch (error) {
        this.publish(entry, { ...entry.state, status: 'stale', error: `Transcript resync failed: ${String(error)}` });
      }
    } else if (next !== entry.state) {
      this.publish(entry, next);
    }
    if (!event.cacheWrite) return;
    const checkpoint = event.cacheWrite;
    entry.persistChain = entry.persistChain.then(async () => {
      const durable = await this.cache.saveNative(entry.cacheKey, checkpoint);
      if (durable) {
        entry.transport.confirmAgentTranscriptCache(checkpoint.confirmationToken);
      }
    }).catch(error => {
      this.publish(entry, { ...entry.state, status: 'stale', error: `Could not persist ${this.agent} history: ${String(error)}` });
    });
  }

  private acceptState(entry: TranscriptEntry<Transport>, native: NativeAgentTranscriptState): void {
    if ((entry.state.revision ?? -1) >= native.revision) return;
    this.publish(entry, agentChatStateFromNative(native));
  }

  private publish(entry: TranscriptEntry<Transport>, state: AgentChatState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
  }

}

export class CodexTranscriptService extends NativeTranscriptService<CodexTranscriptTransport> {
  constructor(cache: AgentChatCache = agentChatCache) {
    super(
      'codex',
      (transport, terminalId, sessionId, handler) => transport.bindCodexAgentTranscript(
        terminalId,
        sessionId,
        handler,
      ),
      cache,
    );
  }
}

export const codexTranscriptService = new CodexTranscriptService();
