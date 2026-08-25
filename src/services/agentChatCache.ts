import type { AgentTranscript } from '../agentChat';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
} from './performanceTrace';

export const AGENT_CHAT_CACHE_SCHEMA_VERSION = 1;

export type AgentChatCacheAgent = 'codex' | 'opencode';
export type AgentChatCursorType = 'codex-jsonl-byte-offset' | 'opencode-event-sequence';

export interface AgentChatCacheKey {
  hostProfileId: string;
  agent: AgentChatCacheAgent;
  sessionId: string;
}

export interface CodexCachedLine {
  rawLine: string;
  endOffset: number;
}

export interface AgentChatCacheEntry extends AgentChatCacheKey {
  transcript: AgentTranscript;
  cursor: number;
  cursorType: AgentChatCursorType;
  schemaVersion: number;
  updatedAt: number;
  checkpoint: Record<string, unknown>;
  codexLines: CodexCachedLine[];
}

export interface AgentChatCache {
  load(key: AgentChatCacheKey): Promise<AgentChatCacheEntry | null>;
  loadCodexLines(key: AgentChatCacheKey): Promise<CodexCachedLine[]>;
  save(entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>): Promise<void>;
  replaceCodex(
    entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
    lines: readonly CodexCachedLine[],
  ): Promise<void>;
  appendCodex(
    entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
    lines: readonly CodexCachedLine[],
  ): Promise<void>;
  deleteSession(key: AgentChatCacheKey): Promise<void>;
  deleteHost(hostProfileId: string): Promise<void>;
}

interface SessionRow {
  transcript_json: string;
  cursor: number;
  cursor_type: AgentChatCursorType;
  schema_version: number;
  updated_at: number;
  checkpoint_json: string;
}

interface LineRow {
  raw_line: string;
  end_offset: number;
}

type SQLiteTransaction = {
  runAsync: (source: string, params: readonly (string | number | null)[]) => Promise<unknown>;
};

type SQLiteDatabase = SQLiteTransaction & {
  execAsync: (source: string) => Promise<void>;
  getFirstAsync: <T>(source: string, params: readonly (string | number | null)[]) => Promise<T | null>;
  getAllAsync: <T>(source: string, params: readonly (string | number | null)[]) => Promise<T[]>;
  withExclusiveTransactionAsync: (task: (transaction: SQLiteTransaction) => Promise<void>) => Promise<void>;
};

const DATABASE_NAME = 'whip-agent-chat.db';

function trace<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const active = beginAppPerformanceTrace(name);
  return operation().finally(() => endAppPerformanceTrace(active));
}

function validTranscript(value: unknown, sessionId: string): value is AgentTranscript {
  if (!value || typeof value !== 'object') return false;
  const transcript = value as Partial<AgentTranscript>;
  return transcript.sessionId === sessionId
    && Array.isArray(transcript.messages)
    && Array.isArray(transcript.turns)
    && (transcript.info === undefined || (transcript.info !== null && typeof transcript.info === 'object'));
}

function values(key: AgentChatCacheKey): [string, AgentChatCacheAgent, string] {
  return [key.hostProfileId, key.agent, key.sessionId];
}

function sessionValues(
  entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
): readonly (string | number)[] {
  return [
    entry.hostProfileId,
    entry.agent,
    entry.sessionId,
    JSON.stringify(entry.transcript),
    entry.cursor,
    entry.cursorType,
    AGENT_CHAT_CACHE_SCHEMA_VERSION,
    Date.now(),
    JSON.stringify(entry.checkpoint),
  ];
}

const UPSERT_SESSION = `
  INSERT INTO agent_chat_session (
    host_profile_id, agent, agent_session_id, transcript_json, cursor,
    cursor_type, schema_version, updated_at, checkpoint_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(host_profile_id, agent, agent_session_id) DO UPDATE SET
    transcript_json = excluded.transcript_json,
    cursor = excluded.cursor,
    cursor_type = excluded.cursor_type,
    schema_version = excluded.schema_version,
    updated_at = excluded.updated_at,
    checkpoint_json = excluded.checkpoint_json
`;

/** SQLite-backed durable transcript cache. The native module is opened lazily. */
export class SQLiteAgentChatCache implements AgentChatCache {
  private database: Promise<SQLiteDatabase> | null = null;

  private async db(): Promise<SQLiteDatabase> {
    if (!this.database) {
      this.database = import('expo-sqlite').then(async sqlite => {
        const database = await sqlite.openDatabaseAsync(DATABASE_NAME) as unknown as SQLiteDatabase;
        await database.execAsync(`
          PRAGMA journal_mode = WAL;
          PRAGMA foreign_keys = ON;
          CREATE TABLE IF NOT EXISTS agent_chat_session (
            host_profile_id TEXT NOT NULL,
            agent TEXT NOT NULL CHECK(agent IN ('codex', 'opencode')),
            agent_session_id TEXT NOT NULL,
            transcript_json TEXT NOT NULL,
            cursor INTEGER NOT NULL,
            cursor_type TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            checkpoint_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (host_profile_id, agent, agent_session_id)
          );
          CREATE TABLE IF NOT EXISTS codex_chat_line (
            host_profile_id TEXT NOT NULL,
            agent TEXT NOT NULL DEFAULT 'codex' CHECK(agent = 'codex'),
            agent_session_id TEXT NOT NULL,
            end_offset INTEGER NOT NULL,
            raw_line TEXT NOT NULL,
            PRIMARY KEY (host_profile_id, agent_session_id, end_offset),
            FOREIGN KEY (host_profile_id, agent, agent_session_id)
              REFERENCES agent_chat_session(host_profile_id, agent, agent_session_id)
              ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS agent_chat_session_host
            ON agent_chat_session(host_profile_id);
        `);
        return database;
      });
    }
    return this.database;
  }

  async load(key: AgentChatCacheKey): Promise<AgentChatCacheEntry | null> {
    return trace('Whip chat cache load', async () => {
      const db = await this.db();
      const row = await db.getFirstAsync<SessionRow>(`
        SELECT transcript_json, cursor, cursor_type, schema_version, updated_at, checkpoint_json
        FROM agent_chat_session
        WHERE host_profile_id = ? AND agent = ? AND agent_session_id = ?
      `, values(key));
      if (!row) return null;
      try {
        if (row.schema_version !== AGENT_CHAT_CACHE_SCHEMA_VERSION) throw new Error('cache schema mismatch');
        const transcript = JSON.parse(row.transcript_json) as unknown;
        const checkpoint = JSON.parse(row.checkpoint_json) as unknown;
        if (!validTranscript(transcript, key.sessionId)
          || !checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)
          || row.cursor_type !== (key.agent === 'codex' ? 'codex-jsonl-byte-offset' : 'opencode-event-sequence')
          || !Number.isSafeInteger(row.cursor) || row.cursor < 0) {
          throw new Error('corrupt chat cache');
        }
        return {
          ...key,
          transcript,
          cursor: row.cursor,
          cursorType: row.cursor_type,
          schemaVersion: row.schema_version,
          updatedAt: row.updated_at,
          checkpoint: checkpoint as Record<string, unknown>,
          codexLines: [],
        };
      } catch {
        await this.deleteSession(key);
        return null;
      }
    });
  }

  async loadCodexLines(key: AgentChatCacheKey): Promise<CodexCachedLine[]> {
    const db = await this.db();
    return (await db.getAllAsync<LineRow>(`
      SELECT raw_line, end_offset FROM codex_chat_line
      WHERE host_profile_id = ? AND agent_session_id = ? ORDER BY end_offset
    `, [key.hostProfileId, key.sessionId])).map(line => ({
      rawLine: line.raw_line,
      endOffset: line.end_offset,
    }));
  }

  async save(entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>): Promise<void> {
    await trace('Whip chat cache persist', async () => {
      const db = await this.db();
      await db.withExclusiveTransactionAsync(transaction => transaction.runAsync(UPSERT_SESSION, sessionValues(entry)).then(() => undefined));
    });
  }

  async replaceCodex(
    entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
    lines: readonly CodexCachedLine[],
  ): Promise<void> {
    await this.writeCodex(entry, lines, true);
  }

  async appendCodex(
    entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
    lines: readonly CodexCachedLine[],
  ): Promise<void> {
    await this.writeCodex(entry, lines, false);
  }

  private async writeCodex(
    entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
    lines: readonly CodexCachedLine[],
    replace: boolean,
  ): Promise<void> {
    await trace('Whip chat cache persist', async () => {
      const db = await this.db();
      await db.withExclusiveTransactionAsync(async transaction => {
        await transaction.runAsync(UPSERT_SESSION, sessionValues(entry));
        if (replace) {
          await transaction.runAsync(
            'DELETE FROM codex_chat_line WHERE host_profile_id = ? AND agent_session_id = ?',
            [entry.hostProfileId, entry.sessionId],
          );
        }
        for (const line of lines) {
          await transaction.runAsync(`
            INSERT OR REPLACE INTO codex_chat_line
              (host_profile_id, agent, agent_session_id, end_offset, raw_line)
            VALUES (?, 'codex', ?, ?, ?)
          `, [entry.hostProfileId, entry.sessionId, line.endOffset, line.rawLine]);
        }
      });
    });
  }

  async deleteSession(key: AgentChatCacheKey): Promise<void> {
    const db = await this.db();
    await db.runAsync(
      'DELETE FROM agent_chat_session WHERE host_profile_id = ? AND agent = ? AND agent_session_id = ?',
      values(key),
    );
  }

  async deleteHost(hostProfileId: string): Promise<void> {
    const db = await this.db();
    await db.runAsync('DELETE FROM agent_chat_session WHERE host_profile_id = ?', [hostProfileId]);
  }
}

/** Deterministic cache used by transcript service tests. */
export class MemoryAgentChatCache implements AgentChatCache {
  private readonly entries = new Map<string, AgentChatCacheEntry>();

  private id(key: AgentChatCacheKey): string {
    return `${key.hostProfileId}\n${key.agent}\n${key.sessionId}`;
  }

  async load(key: AgentChatCacheKey): Promise<AgentChatCacheEntry | null> {
    const entry = this.entries.get(this.id(key));
    if (!entry) return null;
    if (entry.schemaVersion !== AGENT_CHAT_CACHE_SCHEMA_VERSION
      || !validTranscript(entry.transcript, key.sessionId)
      || entry.cursorType !== (key.agent === 'codex' ? 'codex-jsonl-byte-offset' : 'opencode-event-sequence')
      || !Number.isSafeInteger(entry.cursor) || entry.cursor < 0) {
      this.entries.delete(this.id(key));
      return null;
    }
    return { ...structuredClone(entry), codexLines: [] };
  }

  async loadCodexLines(key: AgentChatCacheKey): Promise<CodexCachedLine[]> {
    return structuredClone(this.entries.get(this.id(key))?.codexLines || []);
  }

  async save(entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>): Promise<void> {
    const previous = this.entries.get(this.id(entry));
    this.entries.set(this.id(entry), {
      ...structuredClone(entry),
      schemaVersion: AGENT_CHAT_CACHE_SCHEMA_VERSION,
      updatedAt: Date.now(),
      codexLines: previous?.codexLines || [],
    });
  }

  async replaceCodex(
    entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
    lines: readonly CodexCachedLine[],
  ): Promise<void> {
    await this.putCodex(entry, lines, true);
  }

  async appendCodex(
    entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
    lines: readonly CodexCachedLine[],
  ): Promise<void> {
    await this.putCodex(entry, lines, false);
  }

  private async putCodex(
    entry: Omit<AgentChatCacheEntry, 'schemaVersion' | 'updatedAt' | 'codexLines'>,
    lines: readonly CodexCachedLine[],
    replace: boolean,
  ): Promise<void> {
    const prior = replace ? [] : this.entries.get(this.id(entry))?.codexLines || [];
    const merged = new Map(prior.map(line => [line.endOffset, line]));
    for (const line of lines) merged.set(line.endOffset, structuredClone(line));
    this.entries.set(this.id(entry), {
      ...structuredClone(entry),
      schemaVersion: AGENT_CHAT_CACHE_SCHEMA_VERSION,
      updatedAt: Date.now(),
      codexLines: [...merged.values()].sort((a, b) => a.endOffset - b.endOffset),
    });
  }

  async deleteSession(key: AgentChatCacheKey): Promise<void> {
    this.entries.delete(this.id(key));
  }

  async deleteHost(hostProfileId: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.hostProfileId === hostProfileId) this.entries.delete(key);
    }
  }

  /** Test-only corruption hook. */
  corrupt(key: AgentChatCacheKey, mutate: (entry: AgentChatCacheEntry) => AgentChatCacheEntry): void {
    const entry = this.entries.get(this.id(key));
    if (entry) this.entries.set(this.id(key), mutate(entry));
  }
}

export const agentChatCache = new SQLiteAgentChatCache();

export function deleteAgentChatCachesForHost(hostProfileId: string): Promise<void> {
  return agentChatCache.deleteHost(hostProfileId);
}
