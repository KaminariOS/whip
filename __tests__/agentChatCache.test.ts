import { MemoryAgentChatCache, SQLiteAgentChatCache } from '../src/services/agentChatCache';

const codexKey = 'stable-profile\ncodex\n11111111-1111-4111-8111-111111111111';
const openCodeKey = 'stable-profile\nopencode\nses_abc123';

function checkpoint(key: string, bytes: number[], namespace = 'stable-profile') {
  return { key, namespace, blob: new Uint8Array(bytes).buffer };
}

describe('opaque agent chat persistence adapter', () => {
  test('stores and returns native checkpoint bytes without interpreting them', async () => {
    const cache = new MemoryAgentChatCache();
    const write = checkpoint(codexKey, [0, 1, 2, 255]);
    await cache.saveNative(write);

    const stored = await cache.loadNative(codexKey);
    expect([...new Uint8Array(stored!)]).toEqual([0, 1, 2, 255]);
    new Uint8Array(write.blob)[0] = 9;
    expect([...new Uint8Array((await cache.loadNative(codexKey))!)]).toEqual([0, 1, 2, 255]);
  });

  test('uses the opaque Rust key without reconstructing host, agent, or session identity', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative(checkpoint(codexKey, [1]));
    await cache.saveNative(checkpoint(openCodeKey, [2]));
    await cache.saveNative(checkpoint('other-host\ncodex\nsame-session', [3], 'other-host'));

    expect([...new Uint8Array((await cache.loadNative(codexKey))!)]).toEqual([1]);
    expect([...new Uint8Array((await cache.loadNative(openCodeKey))!)]).toEqual([2]);
  });

  test('serializes writes for one opaque key in arrival order', async () => {
    const cache = new MemoryAgentChatCache();
    const first = cache.saveNative(checkpoint(codexKey, [1]));
    const second = cache.saveNative(checkpoint(codexKey, [2]));
    await Promise.all([second, first]);

    expect([...new Uint8Array((await cache.loadNative(codexKey))!)]).toEqual([2]);
  });

  test('deletes checkpoints by the native namespace used for host cleanup', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative(checkpoint(codexKey, [1]));
    await cache.saveNative(checkpoint('other-key', [2], 'other-host'));
    await cache.deleteHost('stable-profile');

    expect(await cache.loadNative(codexKey)).toBeNull();
    expect(await cache.loadNative('other-key')).not.toBeNull();
  });

  test('migrates P0 native blobs to the Rust key and removes obsolete semantic tables', async () => {
    const execAsync = jest.fn(async (_sql: string) => undefined);
    const getFirstAsync = jest.fn(async (sql: string) => (
      sql.includes('sqlite_master')
        ? { name: 'native_agent_chat_cache' }
        : { cache_blob: new Uint8Array([7, 8]) }
    ));
    const database = {
      execAsync,
      getFirstAsync,
      runAsync: jest.fn(),
      withExclusiveTransactionAsync: jest.fn(),
    };

    const cache = new SQLiteAgentChatCache(async () => database as never);
    await expect(cache.loadNative(codexKey)).resolves.toEqual(new Uint8Array([7, 8]).buffer);

    const schema = execAsync.mock.calls[0]?.[0] ?? '';
    const migration = execAsync.mock.calls[1]?.[0] ?? '';
    expect(migration).toContain('host_profile_id || char(10) || agent || char(10) || agent_session_id');
    expect(migration).toContain('DROP TABLE native_agent_chat_cache');
    expect(schema).toContain('DROP TABLE IF EXISTS agent_chat_session');
  });
});
