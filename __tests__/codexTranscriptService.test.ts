import type { TranscriptPart } from '../src/agentChat';
import { MemoryAgentChatCache } from '../src/services/agentChatCache';
import { CodexTranscriptService, type CodexTranscriptTransport } from '../src/services/CodexTranscriptService';

const encoder = new TextEncoder();
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const pathFor = (id: string) => `/home/me/.codex/sessions/rollout-${id}.jsonl`;
const event = (type: string, payload: Record<string, unknown>) => JSON.stringify({
  timestamp: '2026-08-24T00:00:00.000Z', type, payload,
});
const userRecord = (message: string) => event('event_msg', { type: 'user_message', message });
const bytesFor = (...lines: string[]) => encoder.encode(`${lines.join('\n')}\n`);

interface TestStream {
  path: string;
  startOffset: number;
  onChunk: (chunk: ArrayBufferView) => void;
  onClosed: (reason?: string) => void;
  close: jest.Mock;
}

function transport(size = 0) {
  const streams: TestStream[] = [];
  const value: CodexTranscriptTransport = {
    resolveCodexRollout: jest.fn(async id => pathFor(id)),
    loadCodexRolloutMetadata: jest.fn(async () => ({ size, fileId: '1:2' })),
    openCodexRolloutStream: jest.fn(async (path, startOffset, onChunk, onClosed) => {
      const stream = { path, startOffset, onChunk, onClosed, close: jest.fn(async () => undefined) };
      streams.push(stream);
      return stream;
    }),
  };
  return { value, streams };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

function send(stream: TestStream, ...lines: string[]): void {
  stream.onChunk(bytesFor(...lines));
}

function userTexts(service: CodexTranscriptService, key: string): string[] {
  return service.getState(key)?.transcript.messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.parts)
    .filter(part => part.type === 'text')
    .map(part => part.text) || [];
}

function toolParts(service: CodexTranscriptService, key: string): TranscriptPart[] {
  return service.getState(key)?.transcript.messages.flatMap(message => message.parts).filter(part => part.type === 'tool') || [];
}

async function seed(cache: MemoryAgentChatCache, ...lines: string[]): Promise<number> {
  const content = bytesFor(...lines);
  const remote = transport(content.byteLength);
  const service = new CodexTranscriptService(cache);
  service.activate('profile', 'connection-1', 'terminal', firstId, remote.value);
  await flush();
  send(remote.streams[0], ...lines);
  await flush();
  service.closeTerminal('connection-1', 'terminal');
  return content.byteLength;
}

describe('Codex persisted rollout lifecycle', () => {
  test('cold bootstrap streams from byte zero and atomically caches raw lines + transcript', async () => {
    const cache = new MemoryAgentChatCache();
    const line = userRecord('first');
    const remote = transport(bytesFor(line).byteLength);
    const service = new CodexTranscriptService(cache);
    const key = service.activate('profile', 'connection', 'terminal', firstId, remote.value);
    await flush();
    expect(remote.streams[0].startOffset).toBe(0);
    send(remote.streams[0], line);
    await flush();

    expect(service.getState(key)?.status).toBe('live');
    expect(userTexts(service, key)).toEqual(['first']);
    const cached = await cache.load({ hostProfileId: 'profile', agent: 'codex', sessionId: firstId });
    expect(cached?.cursor).toBe(bytesFor(line).byteLength);
    expect((await cache.loadCodexLines({ hostProfileId: 'profile', agent: 'codex', sessionId: firstId })).map(item => item.rawLine)).toEqual([line]);
  });

  test('cursor stops at the last complete valid record across UTF-8 chunks and an incomplete tail', async () => {
    jest.useFakeTimers();
    const cache = new MemoryAgentChatCache();
    const line = userRecord('你好');
    const complete = bytesFor(line);
    const incomplete = encoder.encode('{"message":"未完成"');
    const remote = transport(complete.byteLength + incomplete.byteLength);
    const service = new CodexTranscriptService(cache);
    service.activate('profile', 'connection', 'terminal', firstId, remote.value);
    await flush();
    const split = complete.indexOf(0xe4) + 1;
    remote.streams[0].onChunk(complete.slice(0, split));
    remote.streams[0].onChunk(complete.slice(split));
    remote.streams[0].onChunk(incomplete);
    jest.advanceTimersByTime(100);
    await flush();
    const cached = await cache.load({ hostProfileId: 'profile', agent: 'codex', sessionId: firstId });
    expect(cached?.cursor).toBe(complete.byteLength);
    expect(await cache.loadCodexLines({ hostProfileId: 'profile', agent: 'codex', sessionId: firstId })).toHaveLength(1);
    service.reset();
    jest.useRealTimers();
  });

  test('a trailing malformed physical line does not independently advance the durable cursor', async () => {
    jest.useFakeTimers();
    const cache = new MemoryAgentChatCache();
    const valid = bytesFor(userRecord('valid'));
    const malformed = encoder.encode('not-json\n');
    const remote = transport(valid.byteLength + malformed.byteLength);
    const service = new CodexTranscriptService(cache);
    service.activate('profile', 'connection', 'terminal', firstId, remote.value);
    await flush();
    remote.streams[0].onChunk(valid);
    remote.streams[0].onChunk(malformed);
    jest.advanceTimersByTime(100);
    await flush();
    const cached = await cache.load({ hostProfileId: 'profile', agent: 'codex', sessionId: firstId });
    expect(cached?.cursor).toBe(valid.byteLength);
    expect(await cache.loadCodexLines({ hostProfileId: 'profile', agent: 'codex', sessionId: firstId })).toHaveLength(1);
    service.reset();
    jest.useRealTimers();
  });

  test('warm recreation publishes cached transcript before rollout resolution finishes', async () => {
    const cache = new MemoryAgentChatCache();
    const cursor = await seed(cache, userRecord('cached'));
    const cachedLines = await cache.loadCodexLines({ hostProfileId: 'profile', agent: 'codex', sessionId: firstId });
    let resolveLines!: (lines: typeof cachedLines) => void;
    jest.spyOn(cache, 'loadCodexLines').mockImplementation(() => new Promise(resolve => { resolveLines = resolve; }));
    let resolvePath!: (path: string) => void;
    const remote = transport(cursor);
    jest.mocked(remote.value.resolveCodexRollout).mockImplementation(() => new Promise(resolve => { resolvePath = resolve; }));
    const service = new CodexTranscriptService(cache);
    const key = service.activate('profile', 'connection-2', 'terminal', firstId, remote.value);
    const listener = jest.fn();
    service.subscribe(key, listener);
    await flush();

    expect(service.getState(key)?.status).toBe('stale');
    expect(userTexts(service, key)).toEqual(['cached']);
    expect(remote.value.resolveCodexRollout).not.toHaveBeenCalled();
    expect(remote.value.openCodexRolloutStream).not.toHaveBeenCalled();
    resolveLines(cachedLines);
    await flush();
    resolvePath(pathFor(firstId));
    await flush();
    expect(remote.streams[0].startOffset).toBe(cursor);
    expect(service.getState(key)?.status).toBe('live');
  });

  test('valid warm cache resumes after the persisted byte offset, never from byte zero', async () => {
    const cache = new MemoryAgentChatCache();
    const cursor = await seed(cache, userRecord('old'));
    const remote = transport(cursor);
    const service = new CodexTranscriptService(cache);
    const key = service.activate('profile', 'connection-2', 'terminal', firstId, remote.value);
    await flush();

    expect(remote.value.loadCodexRolloutMetadata).toHaveBeenCalledWith(pathFor(firstId));
    expect(remote.value.openCodexRolloutStream).toHaveBeenCalledWith(
      pathFor(firstId), cursor, expect.any(Function), expect.any(Function),
    );
    expect(userTexts(service, key)).toEqual(['old']);
  });

  test('local raw replay restores old tool mappings for a result arriving after restart', async () => {
    const cache = new MemoryAgentChatCache();
    const call = event('response_item', {
      type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: { cmd: 'git status' },
    });
    const cursor = await seed(cache, call);
    const result = event('response_item', {
      type: 'custom_tool_call_output', call_id: 'call_1', output: 'clean',
    });
    const remote = transport(cursor + bytesFor(result).byteLength);
    const service = new CodexTranscriptService(cache);
    const key = service.activate('profile', 'connection-2', 'terminal', firstId, remote.value);
    await flush();
    expect(remote.streams[0].startOffset).toBe(cursor);
    send(remote.streams[0], result);
    await flush();

    expect(toolParts(service, key)).toEqual([
      expect.objectContaining({
        id: 'tool:call_1', type: 'tool', tool: 'shell',
        state: expect.objectContaining({ status: 'completed', output: 'clean' }),
      }),
    ]);
  });

  test('truncated rollout invalidates the cursor and performs a byte-zero rebuild', async () => {
    const cache = new MemoryAgentChatCache();
    const cursor = await seed(cache, userRecord('cached'));
    const remote = transport(cursor - 1);
    const service = new CodexTranscriptService(cache);
    service.activate('profile', 'connection-2', 'terminal', firstId, remote.value);
    await flush();
    expect(remote.streams[0].startOffset).toBe(0);
  });

  test('changed rollout path invalidates a warm cursor', async () => {
    const cache = new MemoryAgentChatCache();
    const cursor = await seed(cache, userRecord('cached'));
    const remote = transport(cursor);
    jest.mocked(remote.value.resolveCodexRollout).mockResolvedValue('/replacement/rollout.jsonl');
    const service = new CodexTranscriptService(cache);
    service.activate('profile', 'connection-2', 'terminal', firstId, remote.value);
    await flush();
    expect(remote.streams[0].startOffset).toBe(0);
  });

  test('replacement at the same path invalidates a warm cursor by file identity', async () => {
    const cache = new MemoryAgentChatCache();
    const cursor = await seed(cache, userRecord('cached'));
    const remote = transport(cursor);
    jest.mocked(remote.value.loadCodexRolloutMetadata).mockResolvedValue({ size: cursor, fileId: '9:9' });
    const service = new CodexTranscriptService(cache);
    service.activate('profile', 'connection-2', 'terminal', firstId, remote.value);
    await flush();
    expect(remote.streams[0].startOffset).toBe(0);
  });

  test('bad local transcript/raw agreement is discarded and rebuilt remotely', async () => {
    const cache = new MemoryAgentChatCache();
    const cursor = await seed(cache, userRecord('cached'));
    const key = { hostProfileId: 'profile', agent: 'codex' as const, sessionId: firstId };
    cache.corrupt(key, entry => ({ ...entry, transcript: { ...entry.transcript, messages: [] } }));
    const remote = transport(cursor);
    const service = new CodexTranscriptService(cache);
    service.activate('profile', 'connection-2', 'terminal', firstId, remote.value);
    await flush();
    expect(remote.streams[0].startOffset).toBe(0);
  });

  test('cached content remains visible when the remote is unavailable', async () => {
    const cache = new MemoryAgentChatCache();
    const cursor = await seed(cache, userRecord('offline history'));
    const remote = transport(cursor);
    jest.mocked(remote.value.resolveCodexRollout).mockRejectedValue(new Error('network unavailable'));
    const service = new CodexTranscriptService(cache);
    const key = service.activate('profile', 'connection-2', 'terminal', firstId, remote.value);
    await flush();
    expect(service.getState(key)?.status).toBe('stale');
    expect(service.getState(key)?.error).toContain('network unavailable');
    expect(userTexts(service, key)).toEqual(['offline history']);
    service.reset();
  });

  test('two terminals share one stable live owner and closing one does not close the stream', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = transport(0);
    const service = new CodexTranscriptService(cache);
    const first = service.activate('profile', 'connection', 'terminal-1', firstId, remote.value);
    const second = service.activate('profile', 'connection', 'terminal-2', firstId, remote.value);
    await flush();
    expect(first).toBe(second);
    expect(remote.value.openCodexRolloutStream).toHaveBeenCalledTimes(1);
    service.closeTerminal('connection', 'terminal-1');
    expect(remote.streams[0].close).not.toHaveBeenCalled();
    service.closeTerminal('connection', 'terminal-2');
    expect(remote.streams[0].close).toHaveBeenCalled();
  });

  test('different stable hosts and native sessions never share cache state', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = transport(0);
    const service = new CodexTranscriptService(cache);
    const a = service.activate('profile-a', 'same-connection', 'terminal-a', firstId, remote.value);
    const b = service.activate('profile-b', 'other-connection', 'terminal-b', secondId, remote.value);
    expect(a).not.toBe(b);
  });
});
