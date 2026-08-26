import type {
  NativeAgentTranscriptState,
  NativeAgentTranscriptUpdate,
} from 'react-native-whip-ssh';

import { MemoryAgentChatCache } from '../src/services/agentChatCache';
import {
  CodexTranscriptService,
  type CodexTranscriptTransport,
} from '../src/services/CodexTranscriptService';

const sessionId = '11111111-1111-4111-8111-111111111111';
const nativeKey = `codex\n${sessionId}`;

function state(revision: number, text = 'hello'): NativeAgentTranscriptState {
  return {
    sessionId,
    agent: 'codex',
    revision,
    status: 'live',
    messages: [{
      id: 'message:1',
      role: 'assistant',
      parts: [{ type: 'text', id: 'part:1', text }],
      diffs: [],
    }],
    turns: [{
      id: 'turn:1',
      assistantMessageIds: ['message:1'],
      status: 'idle',
      diffs: [],
    }],
  };
}

function fakeTransport(initial = state(1)) {
  let current = initial;
  let handler: ((event: NativeAgentTranscriptUpdate) => void) | undefined;
  const value: CodexTranscriptTransport = {
    openCodexAgentTranscript: jest.fn((_terminalId, _sessionId, _cache, next) => {
      handler = next;
      return { key: nativeKey, state: current };
    }),
    agentTranscript: jest.fn(() => current),
    closeAgentTranscript: jest.fn(),
    closeAgentTranscriptTerminal: jest.fn(),
    confirmAgentTranscriptCache: jest.fn(() => true),
  };
  return {
    value,
    update(next: NativeAgentTranscriptState, cacheWrite?: NativeAgentTranscriptUpdate['cacheWrite']) {
      current = next;
      handler?.({ key: nativeKey, state: next, cacheWrite });
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function assistantText(service: CodexTranscriptService, key: string): string | undefined {
  const value = service.getState(key)?.transcript.messages[0]?.parts[0];
  return value?.type === 'text' ? value.text : undefined;
}

describe('Codex native transcript facade', () => {
  test('hands an opaque cache blob to Rust and projects the typed initial state', async () => {
    const cache = new MemoryAgentChatCache();
    const blob = new Uint8Array([1, 2, 3]).buffer;
    await cache.saveNative({ hostProfileId: 'profile', agent: 'codex', sessionId }, blob);
    const remote = fakeTransport();
    const service = new CodexTranscriptService(cache);
    const key = service.activate('profile', 'host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();

    expect(remote.value.openCodexAgentTranscript).toHaveBeenCalledWith(
      'terminal-1', sessionId, expect.any(ArrayBuffer), expect.any(Function),
    );
    const passed = jest.mocked(remote.value.openCodexAgentTranscript).mock.calls[0][2];
    expect([...new Uint8Array(passed!)]).toEqual([1, 2, 3]);
    expect(service.getState(key)).toEqual(expect.objectContaining({ revision: 1, status: 'live' }));
    expect(assistantText(service, key)).toBe('hello');
  });

  test('uses monotonic native revisions and ignores an older callback', async () => {
    const remote = fakeTransport();
    const service = new CodexTranscriptService(new MemoryAgentChatCache());
    const key = service.activate('profile', 'host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    remote.update(state(3, 'new'));
    remote.update(state(2, 'old'));

    expect(service.getState(key)?.revision).toBe(3);
    expect(assistantText(service, key)).toBe('new');
  });

  test('persists the opaque native checkpoint before confirming it', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = fakeTransport();
    const service = new CodexTranscriptService(cache);
    service.activate('profile', 'host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    const blob = new Uint8Array([8, 9]).buffer;
    remote.update(state(2), { key: 'cache-key', blob, confirmationToken: 'confirm-1' });
    await flush();

    expect(remote.value.confirmAgentTranscriptCache).toHaveBeenCalledWith('confirm-1');
    const stored = await cache.loadNative({ hostProfileId: 'profile', agent: 'codex', sessionId });
    expect([...new Uint8Array(stored!)]).toEqual([8, 9]);
  });

  test('does not confirm a checkpoint whose cache write failed', async () => {
    const cache = new MemoryAgentChatCache();
    jest.spyOn(cache, 'saveNative').mockRejectedValue(new Error('disk full'));
    const remote = fakeTransport();
    const service = new CodexTranscriptService(cache);
    const key = service.activate('profile', 'host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    remote.update(state(2), {
      key: 'cache-key', blob: new Uint8Array([1]).buffer, confirmationToken: 'never-confirm',
    });
    await flush();

    expect(remote.value.confirmAgentTranscriptCache).not.toHaveBeenCalled();
    expect(service.getState(key)).toEqual(expect.objectContaining({
      status: 'stale', error: expect.stringContaining('disk full'),
    }));
  });

  test('two terminals share one logical session and close independently', async () => {
    const remote = fakeTransport();
    const service = new CodexTranscriptService(new MemoryAgentChatCache());
    const first = service.activate('profile', 'host-runtime', 'terminal-1', sessionId, remote.value);
    const second = service.activate('profile', 'host-runtime', 'terminal-2', sessionId, remote.value);
    await flush();

    expect(first).toBe(second);
    service.closeTerminal('host-runtime', 'terminal-1');
    expect(remote.value.closeAgentTranscriptTerminal).toHaveBeenCalledWith('terminal-1');
    expect(remote.value.closeAgentTranscript).not.toHaveBeenCalled();
    service.closeTerminal('host-runtime', 'terminal-2');
    expect(remote.value.closeAgentTranscriptTerminal).toHaveBeenCalledWith('terminal-2');
    expect(remote.value.closeAgentTranscript).toHaveBeenCalledWith(nativeKey);
  });
});
