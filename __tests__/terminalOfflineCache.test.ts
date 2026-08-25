const { createTerminalOfflineCache } = require('../scripts/terminal-offline-cache.cjs') as {
  createTerminalOfflineCache: (options: Record<string, unknown>) => {
    configure: (options: { enabled: boolean; scrollback: number }) => void;
    markDirty: () => void;
    snapshot: (reason: string, force?: boolean) => boolean;
    dispose: () => void;
  };
};

describe('terminal offline cache scheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('serializes once after an output burst instead of on every frame', () => {
    const serialize = jest.fn(() => 'cached state');
    const send = jest.fn();
    const cache = createTerminalOfflineCache({ serialize, send, now: () => 10 });
    cache.configure({ enabled: true, scrollback: 2000 });

    cache.markDirty();
    jest.advanceTimersByTime(500);
    cache.markDirty();
    jest.advanceTimersByTime(749);
    expect(serialize).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith({ scrollback: 2000 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cache-snapshot',
      reason: 'idle',
      transcript: 'cached state',
    }));
  });

  test('forces a dirty snapshot at an eviction boundary without a recurring timer', () => {
    const serialize = jest.fn(() => 'latest state');
    const send = jest.fn();
    const cache = createTerminalOfflineCache({ serialize, send, now: () => 10 });
    cache.configure({ enabled: true, scrollback: 5000 });
    cache.markDirty();

    expect(cache.snapshot('eviction')).toBe(true);
    expect(serialize).toHaveBeenCalledTimes(1);
    jest.runOnlyPendingTimers();
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  test('does no cache work when disabled for SSH terminals', () => {
    const serialize = jest.fn(() => 'ssh state');
    const cache = createTerminalOfflineCache({ serialize, send: jest.fn() });
    cache.configure({ enabled: false, scrollback: 5000 });

    cache.markDirty();
    jest.runOnlyPendingTimers();
    expect(cache.snapshot('background', true)).toBe(false);
    expect(serialize).not.toHaveBeenCalled();
  });

  test('contains serialization failures so lifecycle cleanup can continue', () => {
    const send = jest.fn();
    const cache = createTerminalOfflineCache({
      serialize: () => { throw new Error('serialize failed'); },
      send,
      now: () => 10,
    });
    cache.configure({ enabled: true, scrollback: 5000 });

    expect(() => cache.snapshot('eviction', true)).not.toThrow();
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'cache-snapshot',
      transcript: null,
    }));
  });
});
