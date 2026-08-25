import { MemoryAgentChatCache } from '../src/services/agentChatCache';
import { OpenCodeTranscriptService, type OpenCodeTranscriptTransport } from '../src/services/OpenCodeTranscriptService';

const session = 'ses_abc123';
const user = (id: string, text: string, created: number) => ({
  info: { id, role: 'user', time: { created } },
  parts: [{ id: `${id}:text`, type: 'text', text }],
});
const assistant = (id: string, parentID: string, text: string, created: number) => ({
  info: { id, role: 'assistant', parentID, time: { created, completed: created + 1 } },
  parts: [{ id: `${id}:text`, type: 'text', text }],
});
const initial = {
  info: { id: session, title: 'Chat', time: { updated: 1 } },
  messages: [user('msg_u1', 'First', 1), assistant('msg_a1', 'msg_u1', 'One', 2)],
};
const events = [
  { seq: 3, type: 'message.updated.1', data: { sessionID: session, info: user('msg_u2', 'Second', 3).info } },
  { seq: 4, type: 'message.part.updated.1', data: { sessionID: session, part: { ...user('msg_u2', 'Second', 3).parts[0], sessionID: session, messageID: 'msg_u2' }, time: 3 } },
  { seq: 5, type: 'message.updated.1', data: { sessionID: session, info: assistant('msg_a2', 'msg_u2', 'Two', 4).info } },
  { seq: 6, type: 'message.part.updated.1', data: { sessionID: session, part: { ...assistant('msg_a2', 'msg_u2', 'Two', 4).parts[0], sessionID: session, messageID: 'msg_a2' }, time: 4 } },
];

async function flush(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

function remote(overrides: Partial<OpenCodeTranscriptTransport> = {}): OpenCodeTranscriptTransport {
  return {
    loadOpenCodeTranscript: jest.fn().mockResolvedValue(initial),
    loadOpenCodeEventCursor: jest.fn().mockResolvedValue(2),
    loadOpenCodeEvents: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

async function seed(cache: MemoryAgentChatCache): Promise<void> {
  const service = new OpenCodeTranscriptService(cache);
  service.activate('profile', 'connection-1', 'terminal', session, remote());
  await flush();
  service.reset();
}

describe('OpenCode persisted incremental reconciliation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('cold start uses the race-safe cursor + export bootstrap', async () => {
    const cache = new MemoryAgentChatCache();
    const transport = remote();
    const service = new OpenCodeTranscriptService(cache);
    const key = service.activate('profile', 'connection', 'terminal', session, transport);
    await flush();

    expect(transport.loadOpenCodeEventCursor).toHaveBeenCalledTimes(1);
    expect(transport.loadOpenCodeTranscript).toHaveBeenCalledTimes(1);
    expect(service.getState(key)?.status).toBe('live');
    expect((await cache.load({ hostProfileId: 'profile', agent: 'opencode', sessionId: session }))?.cursor).toBe(2);
  });

  test('warm recreation emits cached history before remote validation and never exports', async () => {
    const cache = new MemoryAgentChatCache();
    await seed(cache);
    let resolveCursor!: (value: number) => void;
    const cursor = new Promise<number>(resolve => { resolveCursor = resolve; });
    const transport = remote({ loadOpenCodeEventCursor: jest.fn(() => cursor) });
    const service = new OpenCodeTranscriptService(cache);
    const key = service.activate('profile', 'connection-2', 'terminal', session, transport);
    const listener = jest.fn();
    service.subscribe(key, listener);
    await flush();

    expect(service.getState(key)?.status).toBe('stale');
    expect(service.getState(key)?.transcript.turns).toHaveLength(1);
    expect(transport.loadOpenCodeTranscript).not.toHaveBeenCalled();
    resolveCursor(2);
    await flush();
    expect(service.getState(key)?.status).toBe('live');
    expect(transport.loadOpenCodeTranscript).not.toHaveBeenCalled();
  });

  test('warm catch-up asks only for events after the persisted cursor and commits cursor + transcript', async () => {
    const cache = new MemoryAgentChatCache();
    await seed(cache);
    const transport = remote({
      loadOpenCodeEventCursor: jest.fn().mockResolvedValue(6),
      loadOpenCodeEvents: jest.fn().mockResolvedValue(events),
    });
    const service = new OpenCodeTranscriptService(cache);
    const key = service.activate('profile', 'connection-2', 'terminal', session, transport);
    await flush();

    expect(transport.loadOpenCodeEvents).toHaveBeenCalledWith(session, 2);
    expect(transport.loadOpenCodeTranscript).not.toHaveBeenCalled();
    expect(service.getState(key)?.transcript.turns).toHaveLength(2);
    const cached = await cache.load({ hostProfileId: 'profile', agent: 'opencode', sessionId: session });
    expect(cached?.cursor).toBe(6);
    expect(cached?.transcript.turns).toHaveLength(2);
  });

  test('polling preserves references and duplicate boundary events are harmless', async () => {
    const cache = new MemoryAgentChatCache();
    const transport = remote({
      loadOpenCodeEvents: jest.fn().mockResolvedValue([{ seq: 2, type: 'session.updated.1', data: { info: initial.info } }, ...events]),
    });
    const service = new OpenCodeTranscriptService(cache);
    const key = service.activate('profile', 'connection', 'terminal', session, transport);
    await flush();
    const first = service.getState(key)!.transcript;
    service.subscribe(key, jest.fn());
    jest.advanceTimersByTime(1_200);
    await flush();

    expect(service.getState(key)?.transcript.turns).toHaveLength(2);
    expect(service.getState(key)?.transcript.messages[0]).toBe(first.messages[0]);
    expect(service.getState(key)?.transcript.turns[0]).toBe(first.turns[0]);
  });

  test('empty polls do not rewrite an unchanged cached transcript', async () => {
    const cache = new MemoryAgentChatCache();
    const save = jest.spyOn(cache, 'save');
    const service = new OpenCodeTranscriptService(cache);
    const key = service.activate('profile', 'connection', 'terminal', session, remote());
    await flush();
    save.mockClear();
    service.subscribe(key, jest.fn());
    jest.advanceTimersByTime(1_200);
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  test('remote cursor behind local cursor automatically performs a full authoritative rebuild', async () => {
    const cache = new MemoryAgentChatCache();
    await seed(cache);
    const transport = remote({ loadOpenCodeEventCursor: jest.fn().mockResolvedValue(1) });
    const service = new OpenCodeTranscriptService(cache);
    service.activate('profile', 'connection-2', 'terminal', session, transport);
    await flush();

    expect(transport.loadOpenCodeTranscript).toHaveBeenCalledTimes(1);
    expect(transport.loadOpenCodeEvents).not.toHaveBeenCalled();
  });

  test('invalid incremental data falls back to export', async () => {
    const cache = new MemoryAgentChatCache();
    await seed(cache);
    const transport = remote({
      loadOpenCodeEventCursor: jest.fn().mockResolvedValue(3),
      loadOpenCodeEvents: jest.fn().mockResolvedValue({ invalid: true }),
    });
    const service = new OpenCodeTranscriptService(cache);
    service.activate('profile', 'connection-2', 'terminal', session, transport);
    await flush();
    expect(transport.loadOpenCodeTranscript).toHaveBeenCalledTimes(1);
  });

  test('closing and reopening drops live ownership but preserves persisted history', async () => {
    const cache = new MemoryAgentChatCache();
    await seed(cache);
    const service = new OpenCodeTranscriptService(cache);
    const firstRemote = remote();
    service.activate('profile', 'connection-2', 'terminal', session, firstRemote);
    await flush();
    service.reconcileTerminals('connection-2', []);
    const secondRemote = remote();
    const key = service.activate('profile', 'connection-3', 'terminal-2', session, secondRemote);
    await flush();
    expect(service.getState(key)?.transcript.turns).toHaveLength(1);
    expect(secondRemote.loadOpenCodeTranscript).not.toHaveBeenCalled();
  });
});
