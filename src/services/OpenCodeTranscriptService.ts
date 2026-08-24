import type { AgentChatState } from '../agentChat';
import { parseOpenCodeTranscript } from '../lib/openCodeTranscript';

export interface OpenCodeTranscriptTransport {
  loadOpenCodeTranscript: (sessionId: string) => Promise<unknown>;
}

type Listener = (state: AgentChatState) => void;
interface Entry {
  key: string;
  hostSessionId: string;
  sessionId: string;
  transport: OpenCodeTranscriptTransport;
  terminals: Set<string>;
  listeners: Set<Listener>;
  state: AgentChatState;
  generation: number;
}

const transcriptKey = (host: string, session: string) => `${host}\nopencode\n${session}`;
const terminalKey = (host: string, terminal: string) => `${host}\n${terminal}`;

export class OpenCodeTranscriptService {
  private readonly entries = new Map<string, Entry>();
  private readonly bindings = new Map<string, string>();

  activate(hostSessionId: string, terminalId: string, sessionId: string, transport: OpenCodeTranscriptTransport): string {
    const key = transcriptKey(hostSessionId, sessionId);
    const terminal = terminalKey(hostSessionId, terminalId);
    const previous = this.bindings.get(terminal);
    if (previous && previous !== key) this.release(terminal);
    this.bindings.set(terminal, key);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, hostSessionId, sessionId, transport, terminals: new Set(), listeners: new Set(), state: { sessionId, items: [], status: 'loading' }, generation: 0 };
      this.entries.set(key, entry);
      this.load(entry);
    } else {
      entry.transport = transport;
      this.load(entry);
    }
    entry.terminals.add(terminal);
    return key;
  }

  subscribe(key: string, listener: Listener): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    listener(entry.state);
    return () => entry.listeners.delete(listener);
  }

  getState(key: string): AgentChatState | null { return this.entries.get(key)?.state || null; }

  refresh(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.load(entry);
  }

  reconcileTerminals(hostSessionId: string, terminalIds: readonly string[]): void {
    const keep = new Set(terminalIds.map(id => terminalKey(hostSessionId, id)));
    for (const terminal of [...this.bindings.keys()]) {
      if (terminal.startsWith(`${hostSessionId}\n`) && !keep.has(terminal)) this.release(terminal);
    }
  }

  private load(entry: Entry): void {
    const generation = ++entry.generation;
    this.publish(entry, { ...entry.state, status: entry.state.items.length ? 'stale' : 'loading', error: undefined });
    entry.transport.loadOpenCodeTranscript(entry.sessionId).then(value => {
      if (generation !== entry.generation) return;
      this.publish(entry, { sessionId: entry.sessionId, items: parseOpenCodeTranscript(value), status: 'live' });
    }).catch(error => {
      if (generation !== entry.generation) return;
      this.publish(entry, { ...entry.state, status: entry.state.items.length ? 'stale' : 'error', error: String(error) });
    });
  }

  private publish(entry: Entry, state: AgentChatState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
  }

  private release(terminal: string): void {
    const key = this.bindings.get(terminal);
    this.bindings.delete(terminal);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.terminals.delete(terminal);
    if (!entry.terminals.size) this.entries.delete(key);
  }
}

export const openCodeTranscriptService = new OpenCodeTranscriptService();
