import type { AgentChatState } from '../agentChat';
import { CODEX_HISTORY_COMPLETE_RECORD } from '../lib/codexSession';
import { CodexRolloutAdapter } from '../lib/codexRolloutAdapter';
import { JsonlFramer } from '../lib/jsonlFramer';

export interface CodexTranscriptStream {
  close: () => Promise<void>;
}

export interface CodexTranscriptTransport {
  resolveCodexRollout: (sessionId: string) => Promise<string | null>;
  openCodexRolloutStream: (
    path: string,
    onChunk: (chunk: ArrayBuffer | ArrayBufferView) => void,
    onClosed: (reason?: string) => void,
  ) => Promise<CodexTranscriptStream>;
}

type Listener = (state: AgentChatState) => void;

interface TranscriptEntry {
  key: string;
  hostSessionId: string;
  sessionId: string;
  transport: CodexTranscriptTransport;
  terminals: Set<string>;
  listeners: Set<Listener>;
  state: AgentChatState;
  stream: CodexTranscriptStream | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  generation: number;
}

function transcriptKey(hostSessionId: string, sessionId: string): string {
  return `${hostSessionId}\n${sessionId}`;
}

function terminalKey(hostSessionId: string, terminalId: string): string {
  return `${hostSessionId}\n${terminalId}`;
}

/** Owns non-serializable transcript channels and RAM-only normalized caches. */
export class CodexTranscriptService {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly bindings = new Map<string, string>();
  private readonly activatedTerminals = new Set<string>();

  activate(hostSessionId: string, terminalId: string, sessionId: string, transport: CodexTranscriptTransport): string {
    const terminal = terminalKey(hostSessionId, terminalId);
    this.activatedTerminals.add(terminal);
    this.bind(hostSessionId, terminalId, sessionId, transport);
    return transcriptKey(hostSessionId, sessionId);
  }

  rebind(hostSessionId: string, terminalId: string, sessionId: string | null, transport: CodexTranscriptTransport): void {
    const terminal = terminalKey(hostSessionId, terminalId);
    if (!this.activatedTerminals.has(terminal)) return;
    const current = this.bindings.get(terminal);
    const next = sessionId ? transcriptKey(hostSessionId, sessionId) : null;
    if (current === next) return;
    this.releaseBinding(terminal);
    if (sessionId) this.bind(hostSessionId, terminalId, sessionId, transport);
  }

  subscribe(key: string, listener: Listener): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    listener(entry.state);
    return () => entry.listeners.delete(listener);
  }

  getState(key: string): AgentChatState | null {
    return this.entries.get(key)?.state || null;
  }

  closeTerminal(hostSessionId: string, terminalId: string): void {
    const terminal = terminalKey(hostSessionId, terminalId);
    this.activatedTerminals.delete(terminal);
    this.releaseBinding(terminal);
  }

  reconcileTerminals(hostSessionId: string, terminalIds: readonly string[]): void {
    const keep = new Set(terminalIds.map(id => terminalKey(hostSessionId, id)));
    for (const terminal of [...this.activatedTerminals]) {
      if (terminal.startsWith(`${hostSessionId}\n`) && !keep.has(terminal)) {
        this.activatedTerminals.delete(terminal);
        this.releaseBinding(terminal);
      }
    }
  }

  reconnectHost(hostSessionId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.hostSessionId === hostSessionId && entry.terminals.size) this.start(entry, true);
    }
  }

  reset(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.bindings.clear();
    this.activatedTerminals.clear();
  }

  private bind(hostSessionId: string, terminalId: string, sessionId: string, transport: CodexTranscriptTransport): void {
    const terminal = terminalKey(hostSessionId, terminalId);
    const key = transcriptKey(hostSessionId, sessionId);
    const current = this.bindings.get(terminal);
    if (current && current !== key) this.releaseBinding(terminal);
    this.bindings.set(terminal, key);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        hostSessionId,
        sessionId,
        transport,
        terminals: new Set(),
        listeners: new Set(),
        state: { sessionId, items: [], status: 'loading' },
        stream: null,
        retryTimer: null,
        generation: 0,
      };
      this.entries.set(key, entry);
      this.start(entry, false);
    } else {
      entry.transport = transport;
    }
    entry.terminals.add(terminal);
  }

  private releaseBinding(terminal: string): void {
    const key = this.bindings.get(terminal);
    this.bindings.delete(terminal);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.terminals.delete(terminal);
    if (!entry.terminals.size) {
      this.disposeEntry(entry);
      this.entries.delete(key);
    }
  }

  private start(entry: TranscriptEntry, rebuilding: boolean): void {
    const generation = ++entry.generation;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    const oldStream = entry.stream;
    entry.stream = null;
    oldStream?.close().catch(() => undefined);
    this.publish(entry, {
      ...entry.state,
      status: rebuilding && entry.state.items.length ? 'stale' : 'loading',
      error: rebuilding ? 'Reconnecting to the remote rollout…' : undefined,
    });

    const staging = new CodexRolloutAdapter();
    let historyComplete = false;
    const framer = new JsonlFramer<Record<string, unknown>>({
      onRecord: record => {
        if (record[CODEX_HISTORY_COMPLETE_RECORD] === true) {
          historyComplete = true;
          this.publish(entry, { sessionId: entry.sessionId, items: staging.snapshot(), status: 'live' });
          return;
        }
        staging.accept(record);
        if (historyComplete) {
          this.publish(entry, { sessionId: entry.sessionId, items: staging.snapshot(), status: 'live' });
        }
      },
      onMalformed: () => undefined,
    });

    entry.transport.resolveCodexRollout(entry.sessionId).then(path => {
      if (generation !== entry.generation) return null;
      if (!path) {
        this.publish(entry, { sessionId: entry.sessionId, items: [], status: 'unavailable', error: 'Codex has not created this rollout yet.' });
        return null;
      }
      return entry.transport.openCodexRolloutStream(
        path,
        chunk => {
          if (generation === entry.generation) framer.push(chunk);
        },
        reason => {
          if (generation !== entry.generation) return;
          framer.end();
          entry.stream = null;
          this.scheduleRetry(entry, reason || 'Transcript stream closed');
        },
      );
    }).then(stream => {
      if (!stream) return;
      if (generation !== entry.generation) {
        stream.close().catch(() => undefined);
        return;
      }
      entry.stream = stream;
    }).catch(error => {
      if (generation === entry.generation) this.scheduleRetry(entry, String(error));
    });
  }

  private scheduleRetry(entry: TranscriptEntry, reason: string): void {
    if (!entry.terminals.size) return;
    this.publish(entry, {
      ...entry.state,
      status: entry.state.items.length ? 'stale' : 'error',
      error: reason,
    });
    if (entry.retryTimer) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (entry.terminals.size) this.start(entry, true);
    }, 1500);
  }

  private publish(entry: TranscriptEntry, state: AgentChatState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
  }

  private disposeEntry(entry: TranscriptEntry): void {
    entry.generation += 1;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    const stream = entry.stream;
    entry.stream = null;
    stream?.close().catch(() => undefined);
    entry.listeners.clear();
  }
}

export const codexTranscriptService = new CodexTranscriptService();
