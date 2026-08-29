import type {
  HostRuntimeConnection,
  NativeAgentTranscriptUpdate,
} from 'react-native-whip-ssh';

import type { AgentChatState } from '../agentChat';
import { agentChatStateFromNative, applyNativeAgentTranscriptUpdate } from '../lib/nativeAgentTranscript';
import { agentChatCache, type AgentChatCache } from './agentChatCache';

export type NativeTranscriptTransport = Pick<
  HostRuntimeConnection,
  | 'agentTranscript'
  | 'bindAgentSession'
  | 'closeAgentTerminal'
  | 'confirmAgentTranscriptCache'
  | 'startAgentSession'
>;

type Listener = (state: AgentChatState) => void;

interface TranscriptEntry {
  nativeKey: string;
  hostSessionId: string;
  sessionId: string;
  transport: NativeTranscriptTransport;
  listeners: Set<Listener>;
  state: AgentChatState;
  persistChain: Promise<void>;
}

/** Agent-neutral UI/listener and opaque-storage facade over Rust AgentSessionManager. */
export class NativeTranscriptService {
  private readonly entries = new Map<string, TranscriptEntry>();

  constructor(
    private readonly agent: 'codex' | 'opencode',
    private readonly cache: AgentChatCache = agentChatCache,
  ) {}

  activate(
    hostSessionId: string,
    terminalId: string,
    sessionId: string,
    transport: NativeTranscriptTransport,
  ): string {
    let boundEntry: TranscriptEntry | undefined;
    const result = transport.bindAgentSession(
      this.agent,
      terminalId,
      sessionId,
      event => boundEntry && this.acceptEvent(boundEntry, event),
    );
    const key = result.key;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        nativeKey: result.key,
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
      const previousRevision = entry.state.revision ?? -1;
      const nativeLifecycleReset = result.state.revision < previousRevision;
      entry.transport = transport;
      entry.hostSessionId = hostSessionId;
      entry.sessionId = sessionId;
      boundEntry = entry;
      if (nativeLifecycleReset) {
        this.publish(entry, agentChatStateFromNative(result.state));
      } else {
        this.acceptState(entry, result.state);
      }
      if (nativeLifecycleReset && result.state.status === 'loading') {
        this.restoreAndStart(entry, terminalId);
      } else {
        this.startNative(entry, terminalId, undefined);
      }
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
    const released = transport?.closeAgentTerminal(terminalId);
    const key = projectionKey ?? released ?? null;
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

  private restoreAndStart(entry: TranscriptEntry, terminalId: string): void {
    this.cache.loadNative(entry.nativeKey).then(blob => {
      this.startNative(entry, terminalId, blob || undefined);
    }).catch(error => {
      this.publish(entry, { ...entry.state, status: 'error', error: String(error) });
      this.startNative(entry, terminalId, undefined);
    });
  }

  private startNative(entry: TranscriptEntry, terminalId: string, cacheBlob: ArrayBuffer | undefined): void {
    try {
      const state = entry.transport.startAgentSession(
        terminalId,
        entry.nativeKey,
        cacheBlob,
      );
      this.acceptState(entry, state);
    } catch (error) {
      // Rust rejects a late cache load when the terminal was rebound. That is
      // expected lifecycle protection, not a visible transcript failure.
      if (/StaleGeneration|no longer bound/i.test(String(error))) {
        return;
      }
      this.publish(entry, { ...entry.state, status: 'error', error: String(error) });
    }
  }

  private acceptEvent(entry: TranscriptEntry, event: NativeAgentTranscriptUpdate): void {
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
      await this.cache.saveNative(checkpoint);
      entry.transport.confirmAgentTranscriptCache(checkpoint.confirmationToken);
    }).catch(error => {
      this.publish(entry, { ...entry.state, status: 'stale', error: `Could not persist ${this.agent} history: ${String(error)}` });
    });
  }

  private acceptState(entry: TranscriptEntry, native: ReturnType<NativeTranscriptTransport['agentTranscript']>): void {
    if ((entry.state.revision ?? -1) >= native.revision) return;
    this.publish(entry, agentChatStateFromNative(native));
  }

  private publish(entry: TranscriptEntry, state: AgentChatState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
  }

}

export class CodexTranscriptService extends NativeTranscriptService {
  constructor(cache: AgentChatCache = agentChatCache) {
    super('codex', cache);
  }
}

export const codexTranscriptService = new CodexTranscriptService();
