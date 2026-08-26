import type {
  NativeAgentTranscriptState,
  NativeAgentTranscriptUpdate,
} from 'react-native-whip-ssh';

import { MemoryAgentChatCache } from '../src/services/agentChatCache';
import {
  OpenCodeTranscriptService,
  type OpenCodeTranscriptTransport,
} from '../src/services/OpenCodeTranscriptService';

const sessionId = 'ses_abc123';
const nativeKey = `opencode:${sessionId}`;

function state(revision: number, text = 'hello'): NativeAgentTranscriptState {
  return {
    sessionId,
    agent: 'opencode',
    revision,
    status: 'live',
    messages: [{
      id: 'message:1', role: 'assistant',
      parts: [{ type: 'text', id: 'part:1', text }],
      diffs: [],
    }],
    turns: [{
      id: 'turn:1', assistantMessageIds: ['message:1'], status: 'idle', diffs: [],
    }],
  };
}

function fakeTransport(initial = state(1)) {
  let current = initial;
  let handler: ((event: NativeAgentTranscriptUpdate) => void) | undefined;
  const value: OpenCodeTranscriptTransport = {
    openOpenCodeAgentTranscript: jest.fn((_terminalId, _sessionId, _cache, next) => {
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

describe('OpenCode native transcript facade', () => {
  test('hands the opaque cache to Rust and projects native updates', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative(
      { hostProfileId: 'profile', agent: 'opencode', sessionId },
      new Uint8Array([1, 2, 3]).buffer,
    );
    const remote = fakeTransport();
    const service = new OpenCodeTranscriptService(cache);
    const key = service.activate('profile', 'host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();

    expect(remote.value.openOpenCodeAgentTranscript).toHaveBeenCalledWith(
      'terminal-1', sessionId, expect.any(ArrayBuffer), expect.any(Function),
    );
    const passed = jest.mocked(remote.value.openOpenCodeAgentTranscript).mock.calls[0][2];
    expect([...new Uint8Array(passed!)]).toEqual([1, 2, 3]);
    expect(service.getState(key)).toEqual(expect.objectContaining({ revision: 1, status: 'live' }));

    remote.update(state(3, 'new'));
    remote.update(state(2, 'old'));
    expect(service.getState(key)?.revision).toBe(3);
    expect(service.getState(key)?.transcript.messages[0].parts[0]).toEqual(
      expect.objectContaining({ text: 'new' }),
    );
  });

  test('persists and confirms native OpenCode cursor checkpoints', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = fakeTransport();
    const service = new OpenCodeTranscriptService(cache);
    service.activate('profile', 'host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    remote.update(state(2), {
      key: nativeKey,
      blob: new Uint8Array([8, 9]).buffer,
      confirmationToken: 'confirm-opencode',
    });
    await flush();

    expect(remote.value.confirmAgentTranscriptCache).toHaveBeenCalledWith('confirm-opencode');
    const stored = await cache.loadNative({ hostProfileId: 'profile', agent: 'opencode', sessionId });
    expect([...new Uint8Array(stored!)]).toEqual([8, 9]);
  });

  test('releases native ownership when its final terminal closes', async () => {
    const remote = fakeTransport();
    const service = new OpenCodeTranscriptService(new MemoryAgentChatCache());
    const key = service.activate('profile', 'host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    service.reconcileTerminals('host-runtime', []);

    expect(remote.value.closeAgentTranscriptTerminal).toHaveBeenCalledWith('terminal-1');
    expect(service.getState(key)).toBeNull();
  });
});
