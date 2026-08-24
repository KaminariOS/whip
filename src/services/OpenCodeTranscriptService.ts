import { emptyTranscript, reconcileTranscript, type AgentChatState } from '../agentChat';
import { applyOpenCodeEvents, parseOpenCodeTranscript } from '../lib/openCodeTranscript';

export interface OpenCodeTranscriptTransport {
  loadOpenCodeTranscript: (sessionId: string) => Promise<unknown>;
  loadOpenCodeEventCursor: (sessionId: string) => Promise<number>;
  loadOpenCodeEvents: (sessionId: string, afterSequence: number) => Promise<unknown>;
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
  pollTimer: ReturnType<typeof setTimeout> | null;
  loading: boolean;
  cursor: number | null;
  generation: number;
}

const POLL_INTERVAL_MS = 1_200;

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
      entry = {
        key,
        hostSessionId,
        sessionId,
        transport,
        terminals: new Set(),
        listeners: new Set(),
        state: { sessionId, transcript: emptyTranscript(sessionId), status: 'loading' },
        pollTimer: null,
        loading: false,
        cursor: null,
        generation: 0,
      };
      this.entries.set(key, entry);
      entry.terminals.add(terminal);
      this.loadSnapshot(entry, true);
    } else {
      entry.transport = transport;
      entry.terminals.add(terminal);
      if (entry.state.status !== 'live') this.loadSnapshot(entry, true);
    }
    return key;
  }

  subscribe(key: string, listener: Listener): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    listener(entry.state);
    this.schedule(entry);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.pollTimer) {
        clearTimeout(entry.pollTimer);
        entry.pollTimer = null;
      }
    };
  }

  getState(key: string): AgentChatState | null { return this.entries.get(key)?.state || null; }

  refresh(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.loadSnapshot(entry, true);
  }

  reconcileTerminals(hostSessionId: string, terminalIds: readonly string[]): void {
    const keep = new Set(terminalIds.map(id => terminalKey(hostSessionId, id)));
    for (const terminal of [...this.bindings.keys()]) {
      if (terminal.startsWith(`${hostSessionId}\n`) && !keep.has(terminal)) this.release(terminal);
    }
  }

  private loadSnapshot(entry: Entry, announce: boolean): void {
    if (entry.loading) return;
    entry.loading = true;
    const generation = ++entry.generation;
    if (announce) {
      this.publish(entry, { ...entry.state, status: entry.state.transcript.turns.length ? 'stale' : 'loading', error: undefined });
    }
    entry.transport.loadOpenCodeEventCursor(entry.sessionId).then(async cursor => ({
      cursor,
      value: await entry.transport.loadOpenCodeTranscript(entry.sessionId),
    })).then(({ cursor, value }) => {
      if (generation !== entry.generation) return;
      const transcript = reconcileTranscript(entry.state.transcript, parseOpenCodeTranscript(value));
      entry.cursor = cursor;
      if (transcript !== entry.state.transcript || entry.state.status !== 'live') {
        this.publish(entry, { sessionId: entry.sessionId, transcript, status: 'live' });
      }
    }).catch(error => {
      if (generation !== entry.generation) return;
      this.publish(entry, { ...entry.state, status: entry.state.transcript.turns.length ? 'stale' : 'error', error: String(error) });
    }).finally(() => {
      if (generation !== entry.generation) return;
      entry.loading = false;
      this.schedule(entry);
    });
  }

  private loadEvents(entry: Entry): void {
    if (entry.loading || entry.cursor === null) return;
    entry.loading = true;
    const generation = ++entry.generation;
    const afterSequence = entry.cursor;
    entry.transport.loadOpenCodeEvents(entry.sessionId, afterSequence).then(value => {
      if (generation !== entry.generation) return;
      const result = applyOpenCodeEvents(entry.state.transcript, value, afterSequence);
      entry.cursor = result.cursor;
      const transcript = reconcileTranscript(entry.state.transcript, result.transcript);
      if (transcript !== entry.state.transcript || entry.state.status !== 'live') {
        this.publish(entry, { sessionId: entry.sessionId, transcript, status: 'live' });
      }
    }).catch(error => {
      if (generation !== entry.generation) return;
      this.publish(entry, { ...entry.state, status: entry.state.transcript.turns.length ? 'stale' : 'error', error: String(error) });
    }).finally(() => {
      if (generation !== entry.generation) return;
      entry.loading = false;
      this.schedule(entry);
    });
  }

  private schedule(entry: Entry): void {
    if (entry.pollTimer || entry.loading || !entry.terminals.size || !entry.listeners.size) return;
    entry.pollTimer = setTimeout(() => {
      entry.pollTimer = null;
      if (entry.terminals.size && entry.listeners.size) this.loadEvents(entry);
    }, POLL_INTERVAL_MS);
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
    if (!entry.terminals.size) {
      entry.generation += 1;
      if (entry.pollTimer) clearTimeout(entry.pollTimer);
      entry.pollTimer = null;
      entry.listeners.clear();
      this.entries.delete(key);
    }
  }
}

export const openCodeTranscriptService = new OpenCodeTranscriptService();
