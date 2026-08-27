import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
} from './performanceTrace';

export interface NativeAgentChatCheckpoint {
  namespace: string;
  key: string;
  blob: ArrayBuffer;
}

export interface AgentChatCache {
  loadNative(key: string): Promise<ArrayBuffer | null>;
  saveNative(checkpoint: NativeAgentChatCheckpoint): Promise<void>;
  deleteHost(namespace: string): Promise<void>;
}

interface NativeCacheRow {
  cache_blob: Uint8Array | ArrayBuffer;
}

type SQLiteTransaction = {
  runAsync: (source: string, params: readonly unknown[]) => Promise<unknown>;
};

type SQLiteDatabase = SQLiteTransaction & {
  execAsync: (source: string) => Promise<void>;
  getFirstAsync: <T>(source: string, params: readonly unknown[]) => Promise<T | null>;
  withExclusiveTransactionAsync: (task: (transaction: SQLiteTransaction) => Promise<void>) => Promise<void>;
};

type SQLiteDatabaseFactory = () => Promise<SQLiteDatabase>;

const DATABASE_NAME = 'whip-agent-chat.db';

function trace<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const active = beginAppPerformanceTrace(name);
  return operation().finally(() => endAppPerformanceTrace(active));
}

/** SQLite-backed persistence for opaque Rust transcript checkpoints. */
export class SQLiteAgentChatCache implements AgentChatCache {
  private database: Promise<SQLiteDatabase> | null = null;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly openDatabase: SQLiteDatabaseFactory = async () => {
      const sqlite = await import('expo-sqlite');
      return sqlite.openDatabaseAsync(DATABASE_NAME) as unknown as Promise<SQLiteDatabase>;
    },
  ) {}

  private async db(): Promise<SQLiteDatabase> {
    if (!this.database) {
      this.database = this.openDatabase().then(async database => {
        await database.execAsync(`
          PRAGMA journal_mode = WAL;
          PRAGMA foreign_keys = ON;
          CREATE TABLE IF NOT EXISTS native_agent_transcript_cache (
            cache_key TEXT PRIMARY KEY NOT NULL,
            namespace TEXT NOT NULL,
            cache_blob BLOB NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS native_agent_transcript_cache_namespace
            ON native_agent_transcript_cache(namespace);
          DROP TABLE IF EXISTS agent_chat_session;
        `);
        // P0 stored native blobs under a TS-composed host/agent/session key.
        // This one-time adapter preserves those rows while all live identity
        // construction now comes from Rust.
        const legacy = await database.getFirstAsync<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_agent_chat_cache'",
          [],
        );
        if (legacy) {
          await database.execAsync(`
            INSERT OR IGNORE INTO native_agent_transcript_cache (
              cache_key, namespace, cache_blob, updated_at
            )
            SELECT
              host_profile_id || char(10) || agent || char(10) || agent_session_id,
              host_profile_id,
              cache_blob,
              updated_at
            FROM native_agent_chat_cache;
            DROP TABLE native_agent_chat_cache;
          `);
        }
        return database;
      });
    }
    return this.database;
  }

  async loadNative(key: string): Promise<ArrayBuffer | null> {
    return trace('Whip chat cache load', async () => {
      const db = await this.db();
      const row = await db.getFirstAsync<NativeCacheRow>(`
        SELECT cache_blob FROM native_agent_transcript_cache WHERE cache_key = ?
      `, [key]);
      if (!row) return null;
      const bytes = row.cache_blob instanceof ArrayBuffer
        ? new Uint8Array(row.cache_blob)
        : new Uint8Array(row.cache_blob.buffer, row.cache_blob.byteOffset, row.cache_blob.byteLength);
      return bytes.slice().buffer;
    });
  }

  saveNative(checkpoint: NativeAgentChatCheckpoint): Promise<void> {
    const previous = this.writes.get(checkpoint.key) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => trace(
      'Whip chat cache persist',
      async () => {
        const db = await this.db();
        await db.withExclusiveTransactionAsync(transaction => transaction.runAsync(`
          INSERT INTO native_agent_transcript_cache (
            cache_key, namespace, cache_blob, updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            namespace = excluded.namespace,
            cache_blob = excluded.cache_blob,
            updated_at = excluded.updated_at
        `, [
          checkpoint.key,
          checkpoint.namespace,
          new Uint8Array(checkpoint.blob),
          Date.now(),
        ]).then(() => undefined));
      },
    ));
    this.writes.set(checkpoint.key, operation);
    return operation.finally(() => {
      if (this.writes.get(checkpoint.key) === operation) this.writes.delete(checkpoint.key);
    });
  }

  async deleteHost(namespace: string): Promise<void> {
    const db = await this.db();
    await db.runAsync('DELETE FROM native_agent_transcript_cache WHERE namespace = ?', [namespace]);
  }
}

interface MemoryCheckpoint {
  namespace: string;
  blob: ArrayBuffer;
}

/** Deterministic opaque persistence adapter used by transcript service tests. */
export class MemoryAgentChatCache implements AgentChatCache {
  private readonly entries = new Map<string, MemoryCheckpoint>();
  private readonly writes = new Map<string, Promise<void>>();

  async loadNative(key: string): Promise<ArrayBuffer | null> {
    return this.entries.get(key)?.blob.slice(0) || null;
  }

  saveNative(checkpoint: NativeAgentChatCheckpoint): Promise<void> {
    const previous = this.writes.get(checkpoint.key) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => {
      this.entries.set(checkpoint.key, {
        namespace: checkpoint.namespace,
        blob: checkpoint.blob.slice(0),
      });
    });
    this.writes.set(checkpoint.key, operation);
    return operation.finally(() => {
      if (this.writes.get(checkpoint.key) === operation) this.writes.delete(checkpoint.key);
    });
  }

  async deleteHost(namespace: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.namespace === namespace) this.entries.delete(key);
    }
  }
}

export const agentChatCache = new SQLiteAgentChatCache();

export function deleteAgentChatCachesForHost(hostProfileId: string): Promise<void> {
  return agentChatCache.deleteHost(hostProfileId);
}
