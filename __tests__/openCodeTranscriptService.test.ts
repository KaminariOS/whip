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
  { seq: 3, type: 'message.updated', data: { sessionID: session, info: user('msg_u2', 'Second', 3).info } },
  { seq: 4, type: 'message.part.updated', data: { sessionID: session, part: { ...user('msg_u2', 'Second', 3).parts[0], sessionID: session, messageID: 'msg_u2' }, time: 3 } },
  { seq: 5, type: 'message.updated', data: { sessionID: session, info: assistant('msg_a2', 'msg_u2', 'Two', 4).info } },
  { seq: 6, type: 'message.part.updated', data: { sessionID: session, part: { ...assistant('msg_a2', 'msg_u2', 'Two', 4).parts[0], sessionID: session, messageID: 'msg_a2' }, time: 4 } },
];

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('OpenCode transcript incremental reconciliation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('loads once, polls only while subscribed, and preserves unchanged turn references', async () => {
    const loadOpenCodeTranscript = jest.fn().mockResolvedValue(initial);
    const loadOpenCodeEventCursor = jest.fn().mockResolvedValue(2);
    const loadOpenCodeEvents = jest.fn().mockResolvedValue(events);
    const transport: OpenCodeTranscriptTransport = {
      loadOpenCodeTranscript,
      loadOpenCodeEventCursor,
      loadOpenCodeEvents,
    };
    const service = new OpenCodeTranscriptService();
    const key = service.activate('host', 'terminal', session, transport);
    await flush();
    const initialTranscript = service.getState(key)!.transcript;
    const firstMessage = initialTranscript.messages[0];
    const firstTurn = initialTranscript.turns[0];
    const listener = jest.fn();
    const unsubscribe = service.subscribe(key, listener);

    jest.advanceTimersByTime(1_200);
    await flush();

    const nextTranscript = service.getState(key)!.transcript;
    expect(loadOpenCodeTranscript).toHaveBeenCalledTimes(1);
    expect(loadOpenCodeEventCursor).toHaveBeenCalledTimes(1);
    expect(loadOpenCodeEvents).toHaveBeenCalledWith(session, 2);
    expect(nextTranscript.turns).toHaveLength(2);
    expect(nextTranscript.messages[0]).toBe(firstMessage);
    expect(nextTranscript.turns[0]).toBe(firstTurn);
    expect(nextTranscript.messages).not.toBe(initialTranscript.messages);
    unsubscribe();
    jest.advanceTimersByTime(2_400);
    await flush();
    expect(loadOpenCodeTranscript).toHaveBeenCalledTimes(1);
    expect(loadOpenCodeEvents).toHaveBeenCalledTimes(1);
  });

  test('does not publish a new transcript when an export is unchanged', async () => {
    const loadOpenCodeTranscript = jest.fn().mockResolvedValue(initial);
    const loadOpenCodeEvents = jest.fn().mockResolvedValue([]);
    const service = new OpenCodeTranscriptService();
    const key = service.activate('host', 'terminal', session, {
      loadOpenCodeTranscript,
      loadOpenCodeEventCursor: jest.fn().mockResolvedValue(2),
      loadOpenCodeEvents,
    });
    await flush();
    const listener = jest.fn();
    const unsubscribe = service.subscribe(key, listener);
    const transcript = service.getState(key)!.transcript;

    jest.advanceTimersByTime(1_200);
    await flush();

    expect(service.getState(key)!.transcript).toBe(transcript);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
