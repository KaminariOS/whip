import { emptyTranscript, reconcileTranscript, type AgentChatState } from '../agentChat';
import { CodexRolloutAdapter } from '../lib/codexRolloutAdapter';
import { JsonlFramer, type JsonlRecordMetadata } from '../lib/jsonlFramer';
import type { CodexRolloutMetadata } from '../lib/codexSession';
import {
  agentChatCache,
  type AgentChatCache,
  type AgentChatCacheEntry,
  type AgentChatCacheKey,
  type CodexCachedLine,
} from './agentChatCache';
import { beginAppPerformanceTrace, endAppPerformanceTrace } from './performanceTrace';

export interface CodexTranscriptStream {
  close: () => Promise<void>;
}

export interface CodexTranscriptTransport {
  resolveCodexRollout: (sessionId: string) => Promise<string | null>;
  loadCodexRolloutMetadata: (path: string) => Promise<CodexRolloutMetadata>;
  openCodexRolloutStream: (
    path: string,
    startOffset: number,
    onChunk: (chunk: ArrayBuffer | ArrayBufferView) => void,
    onClosed: (reason?: string) => void,
  ) => Promise<CodexTranscriptStream>;
}

type Listener = (state: AgentChatState) => void;

interface TranscriptEntry {
  key: string;
  cacheKey: AgentChatCacheKey;
  hostSessionId: string;
  sessionId: string;
  transport: CodexTranscriptTransport;
  terminals: Set<string>;
  listeners: Set<Listener>;
  state: AgentChatState;
  stream: CodexTranscriptStream | null;
  connected: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistChain: Promise<void>;
  generation: number;
  adapter: CodexRolloutAdapter;
  rolloutPath: string | null;
  rolloutFileId: string | null;
  catchUpTarget: number;
  receivedOffset: number;
  committableOffset: number;
  committedOffset: number;
  pendingLines: CodexCachedLine[];
  replaceOnNextPersist: boolean;
  catchUpCommitQueued: boolean;
  hasDurableCache: boolean;
  live: boolean;
}

const PERSIST_DEBOUNCE_MS = 100;

function transcriptKey(hostProfileId: string, sessionId: string): string {
  return `${hostProfileId}\ncodex\n${sessionId}`;
}

function terminalKey(hostSessionId: string, terminalId: string): string {
  return `${hostSessionId}\n${terminalId}`;
}

/** Owns one live stream per stable host profile + Codex session. */
export class CodexTranscriptService {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly bindings = new Map<string, string>();
  private readonly activatedTerminals = new Set<string>();

  constructor(private readonly cache: AgentChatCache = agentChatCache) {}

  activate(
    hostProfileId: string,
    hostSessionId: string,
    terminalId: string,
    sessionId: string,
    transport: CodexTranscriptTransport,
  ): string {
    const terminal = terminalKey(hostSessionId, terminalId);
    this.activatedTerminals.add(terminal);
    this.bind(hostProfileId, hostSessionId, terminalId, sessionId, transport);
    return transcriptKey(hostProfileId, sessionId);
  }

  rebind(
    hostProfileId: string,
    hostSessionId: string,
    terminalId: string,
    sessionId: string | null,
    transport: CodexTranscriptTransport,
  ): void {
    const terminal = terminalKey(hostSessionId, terminalId);
    if (!this.activatedTerminals.has(terminal)) return;
    const current = this.bindings.get(terminal);
    const next = sessionId ? transcriptKey(hostProfileId, sessionId) : null;
    if (current === next) return;
    this.releaseBinding(terminal);
    if (sessionId) this.bind(hostProfileId, hostSessionId, terminalId, sessionId, transport);
  }

  subscribe(key: string, listener: Listener): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    listener(entry.state);
    return () => entry.listeners.delete(listener);
  }

  getState(key: string): AgentChatState | null { return this.entries.get(key)?.state || null; }

  hasCachedHistory(key: string): boolean {
    const state = this.entries.get(key)?.state;
    return state?.status === 'live' || state?.status === 'stale';
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
      if (entry.hostSessionId === hostSessionId && entry.terminals.size) this.restart(entry, 'Reconnecting to the remote rollout…');
    }
  }

  reset(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.bindings.clear();
    this.activatedTerminals.clear();
  }

  private bind(
    hostProfileId: string,
    hostSessionId: string,
    terminalId: string,
    sessionId: string,
    transport: CodexTranscriptTransport,
  ): void {
    const terminal = terminalKey(hostSessionId, terminalId);
    const key = transcriptKey(hostProfileId, sessionId);
    const current = this.bindings.get(terminal);
    if (current && current !== key) this.releaseBinding(terminal);
    this.bindings.set(terminal, key);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        cacheKey: { hostProfileId, agent: 'codex', sessionId },
        hostSessionId,
        sessionId,
        transport,
        terminals: new Set(),
        listeners: new Set(),
        state: { sessionId, transcript: emptyTranscript(sessionId), status: 'loading' },
        stream: null,
        connected: false,
        retryTimer: null,
        persistTimer: null,
        persistChain: Promise.resolve(),
        generation: 0,
        adapter: new CodexRolloutAdapter(sessionId),
        rolloutPath: null,
        rolloutFileId: null,
        catchUpTarget: 0,
        receivedOffset: 0,
        committableOffset: 0,
        committedOffset: 0,
        pendingLines: [],
        replaceOnNextPersist: false,
        catchUpCommitQueued: false,
        hasDurableCache: false,
        live: false,
      };
      this.entries.set(key, entry);
      this.restoreAndConnect(entry);
    } else {
      entry.hostSessionId = hostSessionId;
      entry.transport = transport;
    }
    entry.terminals.add(terminal);
  }

  private restoreAndConnect(entry: TranscriptEntry): void {
    const generation = ++entry.generation;
    const loadTrace = beginAppPerformanceTrace('Whip chat cache restore/replay');
    this.cache.load(entry.cacheKey).then(async cached => {
      if (generation !== entry.generation) return;
      let restored = false;
      if (cached?.cursorType === 'codex-jsonl-byte-offset') {
        entry.hasDurableCache = true;
        this.publish(entry, { sessionId: entry.sessionId, transcript: cached.transcript, status: 'stale' });
        try {
          const lines = await this.cache.loadCodexLines(entry.cacheKey);
          if (generation !== entry.generation) return;
          entry.adapter = this.replayCache(entry, cached, lines);
          entry.committedOffset = cached.cursor;
          entry.receivedOffset = cached.cursor;
          entry.committableOffset = cached.cursor;
          entry.rolloutPath = typeof cached.checkpoint.rolloutPath === 'string'
            ? cached.checkpoint.rolloutPath
            : null;
          entry.rolloutFileId = typeof cached.checkpoint.rolloutFileId === 'string'
            ? cached.checkpoint.rolloutFileId
            : null;
          restored = true;
        } catch {
          await this.cache.deleteSession(entry.cacheKey);
          entry.adapter = new CodexRolloutAdapter(entry.sessionId);
          entry.committedOffset = 0;
          entry.receivedOffset = 0;
          entry.committableOffset = 0;
          entry.rolloutPath = null;
          entry.rolloutFileId = null;
          entry.hasDurableCache = false;
        }
      }
      endAppPerformanceTrace(loadTrace);
      this.resolveAndOpen(entry, generation, restored);
    }).catch(error => {
      if (generation !== entry.generation) return;
      endAppPerformanceTrace(loadTrace);
      this.scheduleRetry(entry, String(error));
    });
  }

  private replayCache(
    entry: TranscriptEntry,
    cached: AgentChatCacheEntry,
    lines: readonly CodexCachedLine[],
  ): CodexRolloutAdapter {
    if (cached.cursor > 0 && lines.at(-1)?.endOffset !== cached.cursor) {
      throw new Error('Codex cache does not cover its cursor');
    }
    if (lines.some((line, index) => (
      !Number.isSafeInteger(line.endOffset)
      || line.endOffset <= (index ? lines[index - 1].endOffset : 0)
      || line.endOffset > cached.cursor
    ))) throw new Error('Codex cached line offsets are invalid');
    const adapter = new CodexRolloutAdapter(entry.sessionId);
    for (const line of lines) {
      try { adapter.accept(JSON.parse(line.rawLine)); } catch { /* Preserve malformed complete lines only for byte coverage. */ }
    }
    if (JSON.stringify(adapter.snapshot()) !== JSON.stringify(cached.transcript)) {
      throw new Error('Codex cached transcript diverged from raw replay');
    }
    return adapter;
  }

  private resolveAndOpen(entry: TranscriptEntry, generation: number, hadCache: boolean): void {
    const trace = beginAppPerformanceTrace('Whip chat incremental remote catch-up');
    entry.transport.resolveCodexRollout(entry.sessionId).then(async path => {
      if (generation !== entry.generation) return;
      if (!path) {
        endAppPerformanceTrace(trace);
        if (entry.state.transcript.turns.length || hadCache) {
          this.publish(entry, { ...entry.state, status: 'stale', error: 'Codex has not created this rollout yet.' });
        } else {
          this.publish(entry, { sessionId: entry.sessionId, transcript: emptyTranscript(entry.sessionId), status: 'unavailable', error: 'Codex has not created this rollout yet.' });
        }
        return;
      }
      const metadata = await entry.transport.loadCodexRolloutMetadata(path);
      if (generation !== entry.generation) return;
      const warmValid = hadCache
        && entry.rolloutPath === path
        && entry.rolloutFileId === metadata.fileId
        && metadata.size >= entry.committedOffset;
      if (hadCache && !warmValid) {
        endAppPerformanceTrace(trace);
        this.beginFullRebuild(entry, path, metadata, generation);
        return;
      }
      entry.rolloutPath = path;
      entry.rolloutFileId = metadata.fileId;
      entry.catchUpTarget = metadata.size;
      entry.receivedOffset = warmValid ? entry.committedOffset : 0;
      entry.committableOffset = entry.receivedOffset;
      entry.replaceOnNextPersist = !warmValid;
      entry.catchUpCommitQueued = false;
      entry.live = false;
      if (!warmValid) entry.adapter = new CodexRolloutAdapter(entry.sessionId);
      await this.openStream(entry, path, entry.receivedOffset, generation, trace);
    }).catch(error => {
      if (generation !== entry.generation) return;
      endAppPerformanceTrace(trace);
      this.scheduleRetry(entry, String(error));
    });
  }

  private beginFullRebuild(
    entry: TranscriptEntry,
    path: string,
    metadata: CodexRolloutMetadata,
    generation: number,
  ): void {
    const trace = beginAppPerformanceTrace('Whip chat full fallback rebuild');
    entry.adapter = new CodexRolloutAdapter(entry.sessionId);
    entry.rolloutPath = path;
    entry.rolloutFileId = metadata.fileId;
    entry.catchUpTarget = metadata.size;
    entry.receivedOffset = 0;
    entry.committableOffset = 0;
    entry.committedOffset = 0;
    entry.pendingLines = [];
    entry.replaceOnNextPersist = true;
    entry.catchUpCommitQueued = false;
    entry.live = false;
    this.openStream(entry, path, 0, generation, trace).catch(error => {
      endAppPerformanceTrace(trace);
      if (generation === entry.generation) this.scheduleRetry(entry, String(error));
    });
  }

  private async openStream(
    entry: TranscriptEntry,
    path: string,
    startOffset: number,
    generation: number,
    trace: ReturnType<typeof beginAppPerformanceTrace>,
  ): Promise<void> {
    const framer = new JsonlFramer<Record<string, unknown>>({
      onRecord: (record, metadata) => {
        if (generation !== entry.generation) return;
        this.stageLine(entry, metadata);
        entry.adapter.accept(record);
        entry.committableOffset = entry.receivedOffset;
        this.requestPersist(
          entry,
          !entry.live && !entry.catchUpCommitQueued && entry.receivedOffset >= entry.catchUpTarget,
          generation,
          trace,
        );
      },
      onMalformed: (_line, _error, metadata) => {
        if (generation !== entry.generation) return;
        this.stageLine(entry, metadata);
      },
      onBlank: metadata => {
        if (generation !== entry.generation) return;
        this.stageLine(entry, metadata);
      },
    });
    const stream = await entry.transport.openCodexRolloutStream(
      path,
      startOffset,
      chunk => { if (generation === entry.generation) framer.push(chunk); },
      reason => {
        if (generation !== entry.generation) return;
        framer.end();
        entry.stream = null;
        entry.connected = false;
        endAppPerformanceTrace(trace);
        this.flushPersist(entry, generation, trace);
        this.scheduleRetry(entry, reason || 'Transcript stream closed');
      },
    );
    if (generation !== entry.generation) {
      stream.close().catch(() => undefined);
      return;
    }
    entry.stream = stream;
    entry.connected = true;
    if (entry.receivedOffset >= entry.catchUpTarget) {
      if (entry.replaceOnNextPersist) this.flushPersist(entry, generation, trace, true);
      else {
        entry.live = true;
        endAppPerformanceTrace(trace);
        this.publish(entry, { sessionId: entry.sessionId, transcript: entry.state.transcript, status: 'live' });
      }
    }
  }

  private stageLine(entry: TranscriptEntry, metadata: JsonlRecordMetadata): void {
    entry.receivedOffset += metadata.consumedBytes;
    entry.pendingLines.push({ rawLine: metadata.rawLine, endOffset: entry.receivedOffset });
  }

  private requestPersist(
    entry: TranscriptEntry,
    immediate: boolean,
    generation: number,
    trace: ReturnType<typeof beginAppPerformanceTrace>,
  ): void {
    if (immediate) {
      entry.catchUpCommitQueued = true;
      this.flushPersist(entry, generation, trace);
      return;
    }
    if (!entry.persistTimer) {
      entry.persistTimer = setTimeout(() => {
        entry.persistTimer = null;
        this.flushPersist(entry, generation, trace);
      }, PERSIST_DEBOUNCE_MS);
    }
  }

  private flushPersist(
    entry: TranscriptEntry,
    generation: number,
    trace: ReturnType<typeof beginAppPerformanceTrace>,
    forceEmpty = false,
  ): Promise<void> {
    if (entry.persistTimer) clearTimeout(entry.persistTimer);
    entry.persistTimer = null;
    const lines = entry.pendingLines.filter(line => line.endOffset <= entry.committableOffset);
    if (!lines.length && !forceEmpty) return entry.persistChain;
    entry.pendingLines = entry.pendingLines.filter(line => line.endOffset > entry.committableOffset);
    const cursor = entry.committableOffset;
    const transcript = entry.adapter.snapshot();
    const replace = entry.replaceOnNextPersist;
    entry.replaceOnNextPersist = false;
    const cached = {
      ...entry.cacheKey,
      transcript,
      cursor,
      cursorType: 'codex-jsonl-byte-offset' as const,
      checkpoint: { rolloutPath: entry.rolloutPath, rolloutFileId: entry.rolloutFileId },
    };
    entry.persistChain = entry.persistChain.then(async () => {
      if (generation !== entry.generation) return;
      if (replace) await this.cache.replaceCodex(cached, lines);
      else await this.cache.appendCodex(cached, lines);
      if (generation !== entry.generation) return;
      entry.committedOffset = cursor;
      entry.hasDurableCache = true;
      const caughtUp = cursor >= entry.catchUpTarget;
      if (caughtUp && entry.connected) {
        entry.live = true;
        endAppPerformanceTrace(trace);
      }
      if ((caughtUp && entry.connected) || entry.live) {
        this.publish(entry, {
          sessionId: entry.sessionId,
          transcript: reconcileTranscript(entry.state.transcript, transcript),
          status: 'live',
        });
      } else if (!entry.connected) {
        this.publish(entry, {
          sessionId: entry.sessionId,
          transcript: reconcileTranscript(entry.state.transcript, transcript),
          status: 'stale',
          error: entry.state.error,
        });
      }
    }).catch(error => {
      if (generation === entry.generation) this.restart(entry, `Could not persist Codex history: ${String(error)}`);
    });
    return entry.persistChain;
  }

  private restart(entry: TranscriptEntry, reason: string): void {
    const oldStream = entry.stream;
    entry.stream = null;
    entry.connected = false;
    oldStream?.close().catch(() => undefined);
    if (entry.persistTimer) clearTimeout(entry.persistTimer);
    entry.persistTimer = null;
    entry.pendingLines = [];
    entry.generation += 1;
    this.publish(entry, { ...entry.state, status: entry.hasDurableCache ? 'stale' : 'loading', error: reason });
    this.restoreAndConnect(entry);
  }

  private scheduleRetry(entry: TranscriptEntry, reason: string): void {
    if (!entry.terminals.size) return;
    this.publish(entry, { ...entry.state, status: entry.hasDurableCache ? 'stale' : 'error', error: reason });
    if (entry.retryTimer) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (entry.terminals.size) this.restart(entry, 'Reconnecting to the remote rollout…');
    }, 1500);
  }

  private publish(entry: TranscriptEntry, state: AgentChatState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
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

  private disposeEntry(entry: TranscriptEntry): void {
    entry.generation += 1;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    if (entry.persistTimer) clearTimeout(entry.persistTimer);
    entry.retryTimer = null;
    entry.persistTimer = null;
    const stream = entry.stream;
    entry.stream = null;
    entry.connected = false;
    stream?.close().catch(() => undefined);
    entry.listeners.clear();
  }
}

export const codexTranscriptService = new CodexTranscriptService();
