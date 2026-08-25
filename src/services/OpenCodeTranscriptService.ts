import { emptyTranscript, reconcileTranscript, type AgentChatState, type AgentTranscript } from '../agentChat';
import { applyOpenCodeEvents, parseOpenCodeTranscript } from '../lib/openCodeTranscript';
import { agentChatCache, type AgentChatCache, type AgentChatCacheKey } from './agentChatCache';
import { beginAppPerformanceTrace, endAppPerformanceTrace } from './performanceTrace';

export interface OpenCodeTranscriptTransport {
  loadOpenCodeTranscript: (sessionId: string) => Promise<unknown>;
  loadOpenCodeEventCursor: (sessionId: string) => Promise<number>;
  loadOpenCodeEvents: (sessionId: string, afterSequence: number) => Promise<unknown>;
}

type Listener = (state: AgentChatState) => void;
interface Entry {
  key: string;
  cacheKey: AgentChatCacheKey;
  hostSessionId: string;
  sessionId: string;
  transport: OpenCodeTranscriptTransport;
  terminals: Set<string>;
  listeners: Set<Listener>;
  state: AgentChatState;
  pollTimer: ReturnType<typeof setTimeout> | null;
  loading: boolean;
  cursor: number | null;
  hasDurableCache: boolean;
  generation: number;
}

const POLL_INTERVAL_MS = 1_200;
const transcriptKey = (hostProfileId: string, session: string) => `${hostProfileId}\nopencode\n${session}`;
const terminalKey = (hostSessionId: string, terminal: string) => `${hostSessionId}\n${terminal}`;

class IncrementalDivergenceError extends Error {}

export class OpenCodeTranscriptService {
  private readonly entries = new Map<string, Entry>();
  private readonly bindings = new Map<string, string>();

  constructor(private readonly cache: AgentChatCache = agentChatCache) {}

  activate(
    hostProfileId: string,
    hostSessionId: string,
    terminalId: string,
    sessionId: string,
    transport: OpenCodeTranscriptTransport,
  ): string {
    const key = transcriptKey(hostProfileId, sessionId);
    const terminal = terminalKey(hostSessionId, terminalId);
    const previous = this.bindings.get(terminal);
    if (previous && previous !== key) this.release(terminal);
    this.bindings.set(terminal, key);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        cacheKey: { hostProfileId, agent: 'opencode', sessionId },
        hostSessionId,
        sessionId,
        transport,
        terminals: new Set(),
        listeners: new Set(),
        state: { sessionId, transcript: emptyTranscript(sessionId), status: 'loading' },
        pollTimer: null,
        loading: false,
        cursor: null,
        hasDurableCache: false,
        generation: 0,
      };
      this.entries.set(key, entry);
      entry.terminals.add(terminal);
      this.restoreAndSync(entry);
    } else {
      entry.hostSessionId = hostSessionId;
      entry.transport = transport;
      entry.terminals.add(terminal);
      if (entry.state.status !== 'live' && !entry.loading) this.catchUp(entry, true);
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

  /** Reconnect/foreground refresh remains incremental. */
  refresh(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.catchUp(entry, true);
  }

  /** An explicit authoritative refresh may replace the cache with a full export. */
  forceRefresh(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.fullSnapshot(entry, true);
  }

  reconcileTerminals(hostSessionId: string, terminalIds: readonly string[]): void {
    const keep = new Set(terminalIds.map(id => terminalKey(hostSessionId, id)));
    for (const terminal of [...this.bindings.keys()]) {
      if (terminal.startsWith(`${hostSessionId}\n`) && !keep.has(terminal)) this.release(terminal);
    }
  }

  reset(): void {
    for (const entry of this.entries.values()) this.dispose(entry);
    this.entries.clear();
    this.bindings.clear();
  }

  private restoreAndSync(entry: Entry): void {
    if (entry.loading) return;
    entry.loading = true;
    const generation = ++entry.generation;
    this.cache.load(entry.cacheKey).then(cached => {
      if (generation !== entry.generation) return;
      if (cached?.cursorType === 'opencode-event-sequence') {
        entry.cursor = cached.cursor;
        entry.hasDurableCache = true;
        this.publish(entry, { sessionId: entry.sessionId, transcript: cached.transcript, status: 'stale' });
      }
      entry.loading = false;
      if (entry.cursor === null) this.fullSnapshot(entry, false);
      else this.catchUp(entry, false);
    }).catch(error => {
      if (generation !== entry.generation) return;
      entry.loading = false;
      this.publish(entry, { ...entry.state, status: entry.hasDurableCache ? 'stale' : 'error', error: String(error) });
    });
  }

  private catchUp(entry: Entry, announce: boolean): void {
    if (entry.loading) return;
    if (entry.cursor === null) {
      this.fullSnapshot(entry, announce);
      return;
    }
    entry.loading = true;
    const generation = ++entry.generation;
    const trace = beginAppPerformanceTrace('Whip chat incremental remote catch-up');
    if (announce) this.publish(entry, { ...entry.state, status: entry.hasDurableCache ? 'stale' : 'loading', error: undefined });
    const localCursor = entry.cursor;
    entry.transport.loadOpenCodeEventCursor(entry.sessionId).then(async remoteCursor => {
      if (generation !== entry.generation) return;
      if (remoteCursor < localCursor) throw new IncrementalDivergenceError('OpenCode event database is behind the cached cursor');
      if (remoteCursor === localCursor) {
        this.publish(entry, { ...entry.state, status: 'live', error: undefined });
        return;
      }
      const value = await entry.transport.loadOpenCodeEvents(entry.sessionId, localCursor);
      if (generation !== entry.generation) return;
      let result;
      try {
        result = applyOpenCodeEvents(entry.state.transcript, value, localCursor);
      } catch (error) {
        throw new IncrementalDivergenceError(String(error));
      }
      if (result.cursor !== remoteCursor) throw new IncrementalDivergenceError('OpenCode incremental events did not reach the remote cursor');
      await this.commit(entry, result.transcript, result.cursor);
      if (generation !== entry.generation) return;
      entry.cursor = result.cursor;
      this.publish(entry, {
        sessionId: entry.sessionId,
        transcript: reconcileTranscript(entry.state.transcript, result.transcript),
        status: 'live',
      });
    }).catch(error => {
      if (generation !== entry.generation) return;
      entry.loading = false;
      endAppPerformanceTrace(trace);
      if (error instanceof IncrementalDivergenceError) {
        this.fullSnapshot(entry, false);
        return;
      }
      this.publish(entry, { ...entry.state, status: entry.hasDurableCache ? 'stale' : 'error', error: String(error) });
      this.schedule(entry);
    }).finally(() => {
      if (generation !== entry.generation || !entry.loading) return;
      entry.loading = false;
      endAppPerformanceTrace(trace);
      this.schedule(entry);
    });
  }

  private fullSnapshot(entry: Entry, announce: boolean): void {
    if (entry.loading) return;
    entry.loading = true;
    const generation = ++entry.generation;
    const trace = beginAppPerformanceTrace('Whip chat full fallback rebuild');
    if (announce) this.publish(entry, { ...entry.state, status: entry.hasDurableCache ? 'stale' : 'loading', error: undefined });
    // Cursor first preserves events racing with the authoritative export.
    entry.transport.loadOpenCodeEventCursor(entry.sessionId).then(async cursor => ({
      cursor,
      transcript: parseOpenCodeTranscript(await entry.transport.loadOpenCodeTranscript(entry.sessionId)),
    })).then(async ({ cursor, transcript }) => {
      if (generation !== entry.generation) return;
      await this.commit(entry, transcript, cursor);
      if (generation !== entry.generation) return;
      entry.cursor = cursor;
      this.publish(entry, {
        sessionId: entry.sessionId,
        transcript: reconcileTranscript(entry.state.transcript, transcript),
        status: 'live',
      });
    }).catch(error => {
      if (generation !== entry.generation) return;
      this.publish(entry, { ...entry.state, status: entry.hasDurableCache ? 'stale' : 'error', error: String(error) });
    }).finally(() => {
      if (generation !== entry.generation) return;
      entry.loading = false;
      endAppPerformanceTrace(trace);
      this.schedule(entry);
    });
  }

  private async commit(entry: Entry, transcript: AgentTranscript, cursor: number): Promise<void> {
    await this.cache.save({
      ...entry.cacheKey,
      transcript,
      cursor,
      cursorType: 'opencode-event-sequence',
      checkpoint: {},
    });
    entry.hasDurableCache = true;
  }

  private schedule(entry: Entry): void {
    if (entry.pollTimer || entry.loading || !entry.terminals.size || !entry.listeners.size) return;
    entry.pollTimer = setTimeout(() => {
      entry.pollTimer = null;
      if (entry.terminals.size && entry.listeners.size) this.loadEvents(entry);
    }, POLL_INTERVAL_MS);
  }

  private loadEvents(entry: Entry): void {
    if (entry.loading || entry.cursor === null) return;
    entry.loading = true;
    const generation = ++entry.generation;
    const afterSequence = entry.cursor;
    entry.transport.loadOpenCodeEvents(entry.sessionId, afterSequence).then(async value => {
      if (generation !== entry.generation) return;
      let result;
      try {
        result = applyOpenCodeEvents(entry.state.transcript, value, afterSequence);
      } catch (error) {
        throw new IncrementalDivergenceError(String(error));
      }
      if (result.cursor === afterSequence && result.transcript === entry.state.transcript) {
        if (entry.state.status !== 'live') this.publish(entry, { ...entry.state, status: 'live', error: undefined });
        return;
      }
      await this.commit(entry, result.transcript, result.cursor);
      if (generation !== entry.generation) return;
      entry.cursor = result.cursor;
      const transcript = reconcileTranscript(entry.state.transcript, result.transcript);
      if (transcript !== entry.state.transcript || entry.state.status !== 'live') {
        this.publish(entry, { sessionId: entry.sessionId, transcript, status: 'live' });
      }
    }).catch(error => {
      if (generation !== entry.generation) return;
      entry.loading = false;
      if (error instanceof IncrementalDivergenceError) {
        this.fullSnapshot(entry, false);
        return;
      }
      this.publish(entry, { ...entry.state, status: entry.hasDurableCache ? 'stale' : 'error', error: String(error) });
      this.schedule(entry);
    }).finally(() => {
      if (generation !== entry.generation || !entry.loading) return;
      entry.loading = false;
      this.schedule(entry);
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
    if (!entry.terminals.size) {
      this.dispose(entry);
      this.entries.delete(key);
    }
  }

  private dispose(entry: Entry): void {
    entry.generation += 1;
    if (entry.pollTimer) clearTimeout(entry.pollTimer);
    entry.pollTimer = null;
    entry.listeners.clear();
  }
}

export const openCodeTranscriptService = new OpenCodeTranscriptService();
