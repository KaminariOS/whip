import { emptyTranscript } from '../src/agentChat';
import {
  AGENT_CHAT_CACHE_SCHEMA_VERSION,
  MemoryAgentChatCache,
  type AgentChatCacheKey,
} from '../src/services/agentChatCache';

const openCodeKey: AgentChatCacheKey = {
  hostProfileId: 'stable-profile', agent: 'opencode', sessionId: 'ses_abc123',
};
const codexKey: AgentChatCacheKey = {
  hostProfileId: 'stable-profile', agent: 'codex', sessionId: '11111111-1111-4111-8111-111111111111',
};

describe('agent chat cache contract', () => {
  test('writes and reads normalized transcript, cursor, type, checkpoint, and version', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.save({
      ...openCodeKey,
      transcript: emptyTranscript(openCodeKey.sessionId),
      cursor: 42,
      cursorType: 'opencode-event-sequence',
      checkpoint: { source: 'event' },
    });
    const stored = await cache.load(openCodeKey);
    expect(stored).toEqual(expect.objectContaining({
      ...openCodeKey,
      cursor: 42,
      cursorType: 'opencode-event-sequence',
      schemaVersion: AGENT_CHAT_CACHE_SCHEMA_VERSION,
      checkpoint: { source: 'event' },
    }));
  });

  test('durable identity is stable host profile ID, not hostSessionId or terminal ID', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.save({
      ...openCodeKey,
      transcript: emptyTranscript(openCodeKey.sessionId),
      cursor: 1,
      cursorType: 'opencode-event-sequence',
      checkpoint: {},
    });
    expect(await cache.load(openCodeKey)).not.toBeNull();
    expect(await cache.load({ ...openCodeKey, hostProfileId: 'new-connection-id' })).toBeNull();
  });

  test('corrupt entries and incompatible schema versions are dropped', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.save({
      ...openCodeKey, transcript: emptyTranscript(openCodeKey.sessionId), cursor: 1,
      cursorType: 'opencode-event-sequence', checkpoint: {},
    });
    cache.corrupt(openCodeKey, entry => ({ ...entry, schemaVersion: AGENT_CHAT_CACHE_SCHEMA_VERSION + 1 }));
    expect(await cache.load(openCodeKey)).toBeNull();

    await cache.save({
      ...openCodeKey, transcript: emptyTranscript(openCodeKey.sessionId), cursor: 1,
      cursorType: 'opencode-event-sequence', checkpoint: {},
    });
    cache.corrupt(openCodeKey, entry => ({ ...entry, transcript: { ...entry.transcript, sessionId: 'wrong' } }));
    expect(await cache.load(openCodeKey)).toBeNull();
  });

  test('deletes one session or every session for a stable host', async () => {
    const cache = new MemoryAgentChatCache();
    for (const key of [openCodeKey, { ...openCodeKey, sessionId: 'ses_other' }]) {
      await cache.save({
        ...key, transcript: emptyTranscript(key.sessionId), cursor: 1,
        cursorType: 'opencode-event-sequence', checkpoint: {},
      });
    }
    await cache.deleteSession(openCodeKey);
    expect(await cache.load(openCodeKey)).toBeNull();
    expect(await cache.load({ ...openCodeKey, sessionId: 'ses_other' })).not.toBeNull();
    await cache.deleteHost(openCodeKey.hostProfileId);
    expect(await cache.load({ ...openCodeKey, sessionId: 'ses_other' })).toBeNull();
  });

  test('stores native transcript checkpoints as opaque bytes', async () => {
    const cache = new MemoryAgentChatCache();
    const blob = new Uint8Array([0, 1, 2, 255]).buffer;
    await cache.saveNative(codexKey, blob);
    const stored = await cache.loadNative(codexKey);
    expect([...new Uint8Array(stored!)]).toEqual([0, 1, 2, 255]);
    new Uint8Array(blob)[0] = 9;
    expect([...new Uint8Array((await cache.loadNative(codexKey))!)]).toEqual([0, 1, 2, 255]);
    await cache.deleteSession(codexKey);
    expect(await cache.loadNative(codexKey)).toBeNull();
  });
});
