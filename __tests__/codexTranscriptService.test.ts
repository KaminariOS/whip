import type {
  NativeAgentTranscriptState,
  NativeAgentTranscriptUpdate,
} from 'react-native-whip-ssh';

import { MemoryAgentChatCache } from '../src/services/agentChatCache';
import { settledPromise } from '../src/lib/promises';
import {
  CodexTranscriptService,
  type NativeTranscriptTransport,
} from '../src/services/CodexTranscriptService';

const sessionId = '11111111-1111-4111-8111-111111111111';
const nativeKey = `profile\ncodex\n${sessionId}`;

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
  const terminals = new Set<string>();
  const value: NativeTranscriptTransport = {
    bindAgentSession: jest.fn((_agent, terminalId, _sessionId, next) => {
      terminals.add(terminalId);
      handler = next;
      return { key: nativeKey, state: current };
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
    update(update: Omit<NativeAgentTranscriptUpdate, 'key'>, snapshot?: NativeAgentTranscriptState) {
      if (snapshot) current = snapshot;
      handler?.({ key: nativeKey, ...update });
    },
  };
}

function cacheWrite(confirmationToken: string, bytes = [8, 9]): NonNullable<NativeAgentTranscriptUpdate['cacheWrite']> {
  return {
    namespace: 'profile', key: nativeKey, blob: new Uint8Array(bytes).buffer,
    confirmationToken,
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
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('hands an opaque cache blob to Rust and projects the typed initial state', async () => {
    const cache = new MemoryAgentChatCache();
    const blob = new Uint8Array([1, 2, 3]).buffer;
    await cache.saveNative({ namespace: 'profile', key: nativeKey, blob });
    const remote = fakeTransport();
    const service = new CodexTranscriptService(cache);
    const key = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();

    expect(remote.value.bindAgentSession).toHaveBeenCalledWith(
      'codex', 'terminal-1', sessionId, expect.any(Function),
    );
    expect(remote.value.startAgentSession).toHaveBeenCalledWith(
      'terminal-1', nativeKey, expect.any(ArrayBuffer),
    );
    const passed = jest.mocked(remote.value.startAgentSession).mock.calls[0][2];
    expect([...new Uint8Array(passed!)]).toEqual([1, 2, 3]);
    expect(service.getState(key)).toEqual(expect.objectContaining({ revision: 1, status: 'live' }));
    expect(assistantText(service, key)).toBe('hello');
  });

  test('uses monotonic native revisions and ignores an older callback', async () => {
    const remote = fakeTransport();
    const service = new CodexTranscriptService(new MemoryAgentChatCache());
    const key = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    remote.update({ revision: 2, deltas: [{ type: 'message-upserted', index: 0, message: state(2, 'new').messages[0] }] });
    remote.update({ revision: 1, deltas: [{ type: 'message-upserted', index: 0, message: state(1, 'old').messages[0] }] });

    expect(service.getState(key)?.revision).toBe(2);
    expect(assistantText(service, key)).toBe('new');
  });

  test('resyncs from a full snapshot after a revision gap', async () => {
    const remote = fakeTransport();
    const service = new CodexTranscriptService(new MemoryAgentChatCache());
    const key = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    remote.update({ revision: 3, deltas: [{ type: 'message-upserted', index: 0, message: state(3, 'ignored').messages[0] }] }, state(3, 'resynced'));

    expect(remote.value.agentTranscript).toHaveBeenCalledWith(nativeKey);
    expect(service.getState(key)?.revision).toBe(3);
    expect(assistantText(service, key)).toBe('resynced');
  });

  test('logs unavailable lifecycle details without transcript payloads', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const remote = fakeTransport();
      const service = new CodexTranscriptService(new MemoryAgentChatCache());
      service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
      await flush();
      remote.update({
        revision: 2,
        deltas: [{
          type: 'status-changed',
          status: 'unavailable',
          error: 'Lookup diagnostic: home=/home/me sessions=present',
        }],
      });

      expect(warning).toHaveBeenCalledWith(
        '[WHIP_CODEX_TRANSCRIPT]',
        expect.stringContaining('"event":"unavailable"'),
      );
      const logged = warning.mock.calls.map(call => call.join(' ')).join('\n');
      expect(logged).toContain('home=/home/me sessions=present');
      expect(logged).not.toContain('hello');
    } finally {
      warning.mockRestore();
    }
  });

  test('keeps untouched message identities for one-message deltas', async () => {
    const initial = state(1);
    initial.messages.unshift({ id: 'message:0', role: 'user', parts: [{ type: 'text', id: 'part:0', text: 'prompt' }], diffs: [] });
    initial.turns[0].userMessageId = 'message:0';
    const remote = fakeTransport(initial);
    const service = new CodexTranscriptService(new MemoryAgentChatCache());
    const key = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    const before = service.getState(key)!;
    remote.update({ revision: 2, deltas: [
      { type: 'message-upserted', index: 1, message: state(2, 'changed').messages[0] },
      { type: 'turn-upserted', index: 0, turn: initial.turns[0] },
    ] });
    const after = service.getState(key)!;

    expect(after.transcript.messages[0]).toBe(before.transcript.messages[0]);
    expect(after.transcript.messages[1]).not.toBe(before.transcript.messages[1]);
    expect(after.transcript.turns[0]).not.toBe(before.transcript.turns[0]);
  });

  test('applies compact rollback truncations', async () => {
    const initial = state(1);
    initial.messages.push({ id: 'message:2', role: 'assistant', parts: [{ type: 'text', id: 'part:2', text: 'later' }], diffs: [] });
    initial.turns.push({ id: 'turn:2', assistantMessageIds: ['message:2'], status: 'idle', diffs: [] });
    const remote = fakeTransport(initial);
    const service = new CodexTranscriptService(new MemoryAgentChatCache());
    const key = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    remote.update({ revision: 2, deltas: [{ type: 'messages-truncated', length: 1 }, { type: 'turns-truncated', length: 1 }] });

    expect(service.getState(key)?.transcript.messages).toHaveLength(1);
    expect(service.getState(key)?.transcript.turns).toHaveLength(1);
  });

  test('persists the opaque native checkpoint before confirming it', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = fakeTransport();
    const service = new CodexTranscriptService(cache);
    service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    const blob = new Uint8Array([8, 9]).buffer;
    remote.update({ revision: 2, deltas: [], cacheWrite: { ...cacheWrite('confirm-1'), blob } });
    await flush();

    expect(remote.value.confirmAgentTranscriptCache).toHaveBeenCalledWith('confirm-1');
    const stored = await cache.loadNative(nativeKey);
    expect([...new Uint8Array(stored!)]).toEqual([8, 9]);
  });

  test('does not confirm a checkpoint whose cache write failed', async () => {
    const cache = new MemoryAgentChatCache();
    jest.spyOn(cache, 'saveNative').mockRejectedValue(new Error('disk full'));
    const remote = fakeTransport();
    const service = new CodexTranscriptService(cache);
    const key = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    await flush();
    remote.update({ revision: 2, deltas: [], cacheWrite: cacheWrite('never-confirm', [1]) });
    await flush();

    expect(remote.value.confirmAgentTranscriptCache).not.toHaveBeenCalled();
    expect(service.getState(key)).toEqual(expect.objectContaining({
      status: 'stale', error: expect.stringContaining('disk full'),
    }));
  });

  test('opaque persistence ordering prevents an in-flight write from regressing a rebound checkpoint', async () => {
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>(resolve => { releaseOlder = resolve; });
    class DelayedCache extends MemoryAgentChatCache {
      private chain = Promise.resolve();

      override saveNative(checkpoint: Parameters<MemoryAgentChatCache['saveNative']>[0]): Promise<void> {
        const operation = this.chain.then(async () => {
          if (new Uint8Array(checkpoint.blob)[0] === 2) await olderGate;
          await super.saveNative(checkpoint);
        });
        this.chain = settledPromise(operation);
        return operation;
      }
    }
    const cache = new DelayedCache();
    const oldRemote = fakeTransport();
    const oldService = new CodexTranscriptService(cache);
    oldService.activate('host-runtime', 'terminal-1', sessionId, oldRemote.value);
    await flush();
    oldRemote.update({ revision: 2, deltas: [], cacheWrite: cacheWrite('old', [2]) });
    await flush();
    oldService.closeTerminal('host-runtime', 'terminal-1');

    const newRemote = fakeTransport(state(3));
    const newService = new CodexTranscriptService(cache);
    newService.activate('host-runtime-2', 'terminal-2', sessionId, newRemote.value);
    await flush();
    newRemote.update({ revision: 4, deltas: [], cacheWrite: cacheWrite('new', [4]) });
    await flush();
    releaseOlder();
    await flush();

    const stored = await cache.loadNative(nativeKey);
    await flush();
    expect([...new Uint8Array(stored!)]).toEqual([4]);
    // Rust owns token validity. TS confirms only after the older blob is
    // durable; a released native session rejects the obsolete token.
    expect(oldRemote.value.confirmAgentTranscriptCache).toHaveBeenCalledWith('old');
    expect(newRemote.value.confirmAgentTranscriptCache).toHaveBeenCalledWith('new');
  });

  test('two terminals share one logical session and close independently', async () => {
    const remote = fakeTransport();
    const service = new CodexTranscriptService(new MemoryAgentChatCache());
    const first = service.activate('host-runtime', 'terminal-1', sessionId, remote.value);
    const second = service.activate('host-runtime', 'terminal-2', sessionId, remote.value);
    await flush();

    expect(first).toBe(second);
    service.closeTerminal('host-runtime', 'terminal-1');
    expect(remote.value.closeAgentTerminal).toHaveBeenCalledWith('terminal-1');
    expect(service.getState(first)).not.toBeNull();
    service.closeTerminal('host-runtime', 'terminal-2');
    expect(remote.value.closeAgentTerminal).toHaveBeenCalledWith('terminal-2');
    expect(service.getState(first)).toBeNull();
  });
});
