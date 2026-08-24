import { CODEX_HISTORY_COMPLETE_RECORD } from '../src/lib/codexSession';
import { CodexTranscriptService, type CodexTranscriptTransport } from '../src/services/CodexTranscriptService';

const encoder = new TextEncoder();
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

function record(message: string): string {
  return JSON.stringify({ timestamp: '2026-08-24T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message } });
}

function transport() {
  const streams: Array<{ onChunk: (chunk: ArrayBufferView) => void; onClosed: (reason?: string) => void; close: jest.Mock }> = [];
  const value: CodexTranscriptTransport = {
    resolveCodexRollout: jest.fn(async id => `/home/me/.codex/sessions/rollout-${id}.jsonl`),
    openCodexRolloutStream: jest.fn(async (_path, onChunk, onClosed) => {
      const stream = { onChunk, onClosed, close: jest.fn(async () => undefined) };
      streams.push(stream);
      return stream;
    }),
  };
  return { value, streams };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function history(stream: ReturnType<typeof transport>['streams'][number], ...lines: string[]): void {
  stream.onChunk(encoder.encode(`${lines.join('\n')}\n${JSON.stringify({ [CODEX_HISTORY_COMPLETE_RECORD]: true })}\n`));
}

describe('Codex transcript RAM cache lifecycle', () => {
  test('first Chat reads once; Chat → Terminal → Chat reuses the stream and cache', async () => {
    const service = new CodexTranscriptService();
    const remote = transport();
    const key = service.activate('host', 'terminal', firstId, remote.value);
    expect(service.hasCachedHistory(key)).toBe(false);
    await flush();
    history(remote.streams[0], record('first'));
    expect(service.hasCachedHistory(key)).toBe(true);
    expect(service.getState(key)?.items).toHaveLength(1);
    service.activate('host', 'terminal', firstId, remote.value);
    await flush();
    expect(remote.value.resolveCodexRollout).toHaveBeenCalledTimes(1);
    expect(remote.value.openCodexRolloutStream).toHaveBeenCalledTimes(1);
  });

  test('treats a completed empty history as cached', async () => {
    const service = new CodexTranscriptService();
    const remote = transport();
    const key = service.activate('host', 'terminal', firstId, remote.value);
    await flush();
    history(remote.streams[0]);
    expect(service.hasCachedHistory(key)).toBe(true);
    expect(service.getState(key)?.items).toEqual([]);
  });

  test('keeps receiving events while there are no visible Chat listeners', async () => {
    const service = new CodexTranscriptService();
    const remote = transport();
    const key = service.activate('host', 'terminal', firstId, remote.value);
    await flush();
    history(remote.streams[0], record('first'));
    remote.streams[0].onChunk(encoder.encode(`${record('while hidden')}\n`));
    expect(service.getState(key)?.items).toHaveLength(2);
  });

  test('changing native session ID closes old stream and binds isolated state', async () => {
    const service = new CodexTranscriptService();
    const remote = transport();
    const oldKey = service.activate('host', 'terminal', firstId, remote.value);
    await flush();
    history(remote.streams[0], record('old'));
    service.rebind('host', 'terminal', secondId, remote.value);
    await flush();
    const newKey = `host\n${secondId}`;
    history(remote.streams[1], record('new'));
    expect(remote.streams[0].close).toHaveBeenCalled();
    expect(service.getState(oldKey)).toBeNull();
    expect(service.getState(newKey)?.items).toEqual([expect.objectContaining({ text: 'new' })]);
  });

  test('closing terminal cleans up its stream and RAM cache', async () => {
    const service = new CodexTranscriptService();
    const remote = transport();
    const key = service.activate('host', 'terminal', firstId, remote.value);
    await flush();
    service.closeTerminal('host', 'terminal');
    expect(remote.streams[0].close).toHaveBeenCalled();
    expect(service.getState(key)).toBeNull();
  });

  test('stream failure stays isolated and reconnect rebuild removes duplicates', async () => {
    const service = new CodexTranscriptService();
    const remote = transport();
    const terminalConnection = { close: jest.fn() };
    const key = service.activate('host', 'terminal', firstId, remote.value);
    await flush();
    history(remote.streams[0], record('same'));
    remote.streams[0].onClosed('network lost');
    expect(service.getState(key)?.status).toBe('stale');
    expect(service.hasCachedHistory(key)).toBe(true);
    expect(terminalConnection.close).not.toHaveBeenCalled();
    service.reconnectHost('host');
    await flush();
    history(remote.streams[1], record('same'));
    expect(service.getState(key)?.items).toHaveLength(1);
    expect(service.getState(key)?.status).toBe('live');
  });

  test('missing rollout returns unavailable without opening a stream', async () => {
    const service = new CodexTranscriptService();
    const remote = transport();
    jest.mocked(remote.value.resolveCodexRollout).mockResolvedValueOnce(null);
    const key = service.activate('host', 'terminal', firstId, remote.value);
    await flush();
    expect(service.getState(key)?.status).toBe('unavailable');
    expect(remote.value.openCodexRolloutStream).not.toHaveBeenCalled();
  });
});
