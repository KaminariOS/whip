import {
  disposeRuntimeMap,
  savedHostConnectionAction,
  shouldRestartLiveSession,
  shouldRetainBackgroundRuntimes,
} from '../src/lib/sessionRuntimePolicy';
import { shouldPersistTerminalHistory } from '../src/lib/terminalHistory';

describe('session runtime lifecycle policy', () => {
  test('retries a failed restored placeholder through a full connection', () => {
    expect(savedHostConnectionAction('error', false)).toBe('connect');
    expect(savedHostConnectionAction('connecting', false)).toBe('wait');
    expect(savedHostConnectionAction('ready', true)).toBe('select');
  });

  test('restarts all sessions on network change but only unhealthy sessions on resume', () => {
    expect(shouldRestartLiveSession('network-change', 'ready')).toBe(true);
    expect(shouldRestartLiveSession('app-resume', 'error')).toBe(true);
    expect(shouldRestartLiveSession('app-resume', 'reconnecting')).toBe(true);
    expect(shouldRestartLiveSession('app-resume', 'ready')).toBe(false);
  });

  test('retains background runtimes only for Android alert monitoring', () => {
    expect(shouldRetainBackgroundRuntimes('android', true, 2)).toBe(true);
    expect(shouldRetainBackgroundRuntimes('android', false, 2)).toBe(false);
    expect(shouldRetainBackgroundRuntimes('ios', true, 2)).toBe(false);
    expect(shouldRetainBackgroundRuntimes('android', true, 0)).toBe(false);
  });

  test('cleans up every runtime and clears the registry', async () => {
    const disconnect = jest.fn();
    const releaseAllTerminals = jest.fn(() => Promise.resolve());
    const runtimes = new Map([
      ['one', { client: { releaseAllTerminals, disconnect } }],
      ['two', { client: { releaseAllTerminals, disconnect } }],
    ]);

    disposeRuntimeMap(runtimes);
    await Promise.resolve();

    expect(runtimes.size).toBe(0);
    expect(releaseAllTerminals).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});

test('failed terminal-history hydration is never safe to persist', () => {
  expect(shouldPersistTerminalHistory(true, true)).toBe(true);
  expect(shouldPersistTerminalHistory(true, false)).toBe(false);
  expect(shouldPersistTerminalHistory(false, true)).toBe(false);
});
