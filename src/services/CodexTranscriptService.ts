import type { NativeAgentTranscriptState, NativeAgentTranscriptUpdate } from 'react-native-whip-ssh';

import { emptyTranscript, type AgentChatState } from '../agentChat';
import { agentChatStateFromNative } from '../lib/nativeAgentTranscript';
import { agentChatCache, type AgentChatCache, type AgentChatCacheKey } from './agentChatCache';

export interface NativeTranscriptTransport {
  agentTranscript(key: string): NativeAgentTranscriptState;
  closeAgentTranscript(key: string): void;
  closeAgentTranscriptTerminal(terminalId: string): void;
  confirmAgentTranscriptCache(confirmationToken: string): boolean;
}

export interface CodexTranscriptTransport extends NativeTranscriptTransport {
  openCodexAgentTranscript(
    terminalId: string,
    sessionId: string,
    cacheBlob: ArrayBuffer | undefined,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState };
}

type Listener = (state: AgentChatState) => void;

interface TranscriptEntry<Transport extends NativeTranscriptTransport> {
  nativeKey: string | null;
  cacheKey: AgentChatCacheKey;
  hostSessionId: string;
  sessionId: string;
  transport: Transport;
  terminals: Set<string>;
  listeners: Set<Listener>;
  state: AgentChatState;
  generation: number;
  persistChain: Promise<void>;
}

function transcriptKey(agent: AgentChatCacheKey['agent'], hostProfileId: string, sessionId: string): string {
  return `${hostProfileId}\n${agent}\n${sessionId}`;
}

function terminalKey(hostSessionId: string, terminalId: string): string {
  return `${hostSessionId}\n${terminalId}`;
}

/** Agent-neutral UI/listener and opaque-storage facade over Rust AgentSessionManager. */
export class NativeTranscriptService<Transport extends NativeTranscriptTransport> {
  private readonly entries = new Map<string, TranscriptEntry<Transport>>();
  private readonly bindings = new Map<string, string>();
  private readonly activatedTerminals = new Set<string>();

  constructor(
    private readonly agent: AgentChatCacheKey['agent'],
    private readonly open: (
      transport: Transport,
      terminalId: string,
      sessionId: string,
      cacheBlob: ArrayBuffer | undefined,
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
    const terminal = terminalKey(hostSessionId, terminalId);
    this.activatedTerminals.add(terminal);
    this.bind(hostProfileId, hostSessionId, terminalId, sessionId, transport);
    return transcriptKey(this.agent, hostProfileId, sessionId);
  }

  rebind(
    hostProfileId: string,
    hostSessionId: string,
    terminalId: string,
    sessionId: string | null,
    transport: Transport,
  ): void {
    const terminal = terminalKey(hostSessionId, terminalId);
    if (!this.activatedTerminals.has(terminal)) return;
    const current = this.bindings.get(terminal);
    const next = sessionId ? transcriptKey(this.agent, hostProfileId, sessionId) : null;
    if (current === next) return;
    this.releaseBinding(terminal, terminalId);
    if (sessionId) this.bind(hostProfileId, hostSessionId, terminalId, sessionId, transport);
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
    if (entry.nativeKey) {
      try { this.acceptState(entry, entry.transport.agentTranscript(entry.nativeKey)); } catch { /* callback state remains usable */ }
    }
    return entry.state;
  }

  hasCachedHistory(key: string): boolean {
    const status = this.entries.get(key)?.state.status;
    return status === 'live' || status === 'stale';
  }

  closeTerminal(hostSessionId: string, terminalId: string): void {
    const terminal = terminalKey(hostSessionId, terminalId);
    this.activatedTerminals.delete(terminal);
    this.releaseBinding(terminal, terminalId);
  }

  reconcileTerminals(hostSessionId: string, terminalIds: readonly string[]): void {
    const keep = new Set(terminalIds.map(id => terminalKey(hostSessionId, id)));
    for (const terminal of [...this.activatedTerminals]) {
      if (!terminal.startsWith(`${hostSessionId}\n`) || keep.has(terminal)) continue;
      this.activatedTerminals.delete(terminal);
      this.releaseBinding(terminal, terminal.slice(hostSessionId.length + 1));
    }
  }

  /** HostRuntime rebinds every native transcript automatically. */
  reconnectHost(_hostSessionId: string): void {}

  reset(): void {
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      if (entry.nativeKey) entry.transport.closeAgentTranscript(entry.nativeKey);
      entry.listeners.clear();
    }
    this.entries.clear();
    this.bindings.clear();
    this.activatedTerminals.clear();
  }

  private bind(
    hostProfileId: string,
    hostSessionId: string,
    terminalId: string,
    sessionId: string,
    transport: Transport,
  ): void {
    const terminal = terminalKey(hostSessionId, terminalId);
    const key = transcriptKey(this.agent, hostProfileId, sessionId);
    const current = this.bindings.get(terminal);
    if (current && current !== key) this.releaseBinding(terminal, terminalId);
    this.bindings.set(terminal, key);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        nativeKey: null,
        cacheKey: { hostProfileId, agent: this.agent, sessionId },
        hostSessionId,
        sessionId,
        transport,
        terminals: new Set(),
        listeners: new Set(),
        state: { sessionId, transcript: emptyTranscript(sessionId), status: 'loading' },
        generation: 0,
        persistChain: Promise.resolve(),
      };
      this.entries.set(key, entry);
      this.restoreAndOpen(entry, terminalId);
    } else {
      entry.hostSessionId = hostSessionId;
      entry.transport = transport;
      this.openNative(entry, terminalId, undefined, entry.generation);
    }
    entry.terminals.add(terminal);
  }

  private restoreAndOpen(entry: TranscriptEntry<Transport>, terminalId: string): void {
    const generation = ++entry.generation;
    this.cache.loadNative(entry.cacheKey).then(blob => {
      if (generation === entry.generation) this.openNative(entry, terminalId, blob || undefined, generation);
    }).catch(error => {
      if (generation !== entry.generation) return;
      this.publish(entry, { ...entry.state, status: 'error', error: String(error) });
      this.openNative(entry, terminalId, undefined, generation);
    });
  }

  private openNative(entry: TranscriptEntry<Transport>, terminalId: string, cacheBlob: ArrayBuffer | undefined, generation: number): void {
    try {
      const result = this.open(
        entry.transport,
        terminalId,
        entry.sessionId,
        cacheBlob,
        event => this.acceptEvent(entry, generation, event),
      );
      if (generation !== entry.generation) {
        entry.transport.closeAgentTranscript(result.key);
        return;
      }
      entry.nativeKey = result.key;
      this.acceptState(entry, result.state);
    } catch (error) {
      if (generation === entry.generation) this.publish(entry, { ...entry.state, status: 'error', error: String(error) });
    }
  }

  private acceptEvent(entry: TranscriptEntry<Transport>, generation: number, event: NativeAgentTranscriptUpdate): void {
    if (generation !== entry.generation || (entry.nativeKey && event.key !== entry.nativeKey)) {
      return;
    }
    entry.nativeKey = event.key;
    this.acceptState(entry, event.state);
    if (!event.cacheWrite) return;
    const { blob, confirmationToken } = event.cacheWrite;
    entry.persistChain = entry.persistChain.then(async () => {
      if (generation !== entry.generation) return;
      await this.cache.saveNative(entry.cacheKey, blob);
      if (generation === entry.generation) entry.transport.confirmAgentTranscriptCache(confirmationToken);
    }).catch(error => {
      if (generation === entry.generation) this.publish(entry, { ...entry.state, status: 'stale', error: `Could not persist ${this.agent} history: ${String(error)}` });
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

  private releaseBinding(terminal: string, terminalId: string): void {
    const key = this.bindings.get(terminal);
    this.bindings.delete(terminal);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.terminals.delete(terminal);
    entry.transport.closeAgentTranscriptTerminal(terminalId);
    if (!entry.terminals.size) {
      entry.generation += 1;
      if (entry.nativeKey) entry.transport.closeAgentTranscript(entry.nativeKey);
      entry.listeners.clear();
      this.entries.delete(key);
    }
  }
}

export class CodexTranscriptService extends NativeTranscriptService<CodexTranscriptTransport> {
  constructor(cache: AgentChatCache = agentChatCache) {
    super(
      'codex',
      (transport, terminalId, sessionId, cacheBlob, handler) => transport.openCodexAgentTranscript(
        terminalId,
        sessionId,
        cacheBlob,
        handler,
      ),
      cache,
    );
  }
}

export const codexTranscriptService = new CodexTranscriptService();
