import type {
  NativeAgentTranscriptState,
  NativeAgentTranscriptUpdate,
} from 'react-native-whip-ssh';

import { MemoryAgentChatCache } from '../src/services/agentChatCache';
import type { NativeTranscriptTransport } from '../src/services/CodexTranscriptService';
import { OpenCodeTranscriptService } from '../src/services/OpenCodeTranscriptService';

const sessionId = 'ses_abc123';
const nativeKey = `profile\nopencode\n${sessionId}`;

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

function fakeTransport(initial = state(1), runtimeIncarnation = 1) {
  let current = initial;
  let handler: ((event: NativeAgentTranscriptUpdate) => void) | undefined;
  const terminals = new Set<string>();
  const value: NativeTranscriptTransport = {
    bindAgentSession: jest.fn((_agent, terminalId, _sessionId, next) => {
      terminals.add(terminalId);
      handler = next;
      return { runtimeIncarnation, key: nativeKey, state: current };
    }),
    startAgentSession: jest.fn((_terminalId, _key, _cache) => current),
    agentTranscript: jest.fn(() => current),
    closeAgentTerminal: jest.fn((terminalId: string) => {
      terminals.delete(terminalId);
      return terminals.size ? undefined : nativeKey;
    }),
    confirmAgentTranscriptCache: jest.fn(() => true),
  };
  return {
    value,
    update(
      update: Omit<NativeAgentTranscriptUpdate, 'key' | 'runtimeIncarnation'>,
      snapshot?: NativeAgentTranscriptState,
    ) {
      if (snapshot) current = snapshot;
      handler?.({ runtimeIncarnation, key: nativeKey, ...update });
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe('OpenCode native transcript facade', () => {
  test('hands the opaque cache to Rust and projects native updates', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative({
      namespace: 'profile', key: nativeKey, blob: new Uint8Array([1, 2, 3]).buffer,
    });
    const remote = fakeTransport();
    const service = new OpenCodeTranscriptService(cache);
    const key = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();

    expect(remote.value.bindAgentSession).toHaveBeenCalledWith(
      'opencode', 'terminal-1', sessionId, expect.any(Function),
    );
    expect(remote.value.startAgentSession).toHaveBeenCalledWith(
      'terminal-1', nativeKey, expect.any(ArrayBuffer),
    );
    const passed = jest.mocked(remote.value.startAgentSession).mock.calls[0][2];
    expect([...new Uint8Array(passed!)]).toEqual([1, 2, 3]);
    expect(service.getState(key)).toEqual(expect.objectContaining({ revision: 1, status: 'live' }));

    remote.update({ revision: 2, deltas: [{ type: 'message-upserted', index: 0, message: state(2, 'new').messages[0] }] });
    remote.update({ revision: 1, deltas: [{ type: 'message-upserted', index: 0, message: state(1, 'old').messages[0] }] });
    expect(service.getState(key)?.revision).toBe(2);
    expect(service.getState(key)?.transcript.messages[0].parts[0]).toEqual(
      expect.objectContaining({ text: 'new' }),
    );
  });

  test('persists and confirms native OpenCode cursor checkpoints', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = fakeTransport();
    const service = new OpenCodeTranscriptService(cache);
    service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    remote.update({ revision: 2, deltas: [], cacheWrite: {
      namespace: 'profile', key: nativeKey, blob: new Uint8Array([8, 9]).buffer,
      confirmationToken: 'confirm-opencode',
    } });
    await flush();

    expect(remote.value.confirmAgentTranscriptCache).toHaveBeenCalledWith('confirm-opencode');
    const stored = await cache.loadNative(nativeKey);
    expect([...new Uint8Array(stored!)]).toEqual([8, 9]);
  });

  test('releases native ownership when its final terminal closes', async () => {
    const remote = fakeTransport();
    const service = new OpenCodeTranscriptService(new MemoryAgentChatCache());
    const key = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    service.closeTerminal('host-runtime', 'terminal-1', key);

    expect(remote.value.closeAgentTerminal).toHaveBeenCalledWith('terminal-1');
    expect(service.getState(key)).toBeNull();
  });
});
