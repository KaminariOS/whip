import {
  destroyRuntime,
  disposeRuntimeMap,
  savedHostConnectionAction,
  shouldRestartLiveSession,
  shouldRetainBackgroundRuntimes,
  waitForRuntimeDestruction,
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
    const disconnect = jest.fn(() => Promise.resolve());
    const releaseAllTerminals = jest.fn(() => Promise.resolve());
    const runtimes = new Map([
      ['one', { client: { releaseAllTerminals, disconnect } }],
      ['two', { client: { releaseAllTerminals, disconnect } }],
    ]);

    await disposeRuntimeMap(runtimes);

    expect(runtimes.size).toBe(0);
    expect(releaseAllTerminals).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  test('waits for native destruction before recreating the same runtime ID', async () => {
    let finishDisconnect!: () => void;
    let markDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>(resolve => {
      markDisconnectStarted = resolve;
    });
    const disconnect = jest.fn(
      () => {
        markDisconnectStarted();
        return new Promise<void>(resolve => {
          finishDisconnect = resolve;
        });
      },
    );
    const runtime = {
      client: {
        releaseAllTerminals: jest.fn(() => Promise.resolve()),
        disconnect,
      },
    };

    const destruction = destroyRuntime('host-1', runtime);
    let recreationStarted = false;
    const recreation = waitForRuntimeDestruction('host-1').then(() => {
      recreationStarted = true;
    });
    await disconnectStarted;

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(recreationStarted).toBe(false);

    finishDisconnect();
    await destruction;
    await recreation;

    expect(recreationStarted).toBe(true);
  });

  test('serializes repeated destruction for one runtime ID', async () => {
    let finishFirstDisconnect!: () => void;
    let markFirstDisconnectStarted!: () => void;
    const firstDisconnectStarted = new Promise<void>(resolve => {
      markFirstDisconnectStarted = resolve;
    });
    const first = {
      client: {
        releaseAllTerminals: jest.fn(() => Promise.resolve()),
        disconnect: jest.fn(
          () => {
            markFirstDisconnectStarted();
            return new Promise<void>(resolve => {
              finishFirstDisconnect = resolve;
            });
          },
        ),
      },
    };
    const second = {
      client: {
        releaseAllTerminals: jest.fn(() => Promise.resolve()),
        disconnect: jest.fn(() => Promise.resolve()),
      },
    };

    const firstDestruction = destroyRuntime('host-1', first);
    const secondDestruction = destroyRuntime('host-1', second);
    await firstDisconnectStarted;

    expect(second.client.releaseAllTerminals).not.toHaveBeenCalled();

    finishFirstDisconnect();
    await firstDestruction;
    await secondDestruction;

    expect(second.client.releaseAllTerminals).toHaveBeenCalledTimes(1);
    expect(second.client.disconnect).toHaveBeenCalledTimes(1);
  });
});

test('failed terminal-history hydration is never safe to persist', () => {
  expect(shouldPersistTerminalHistory(true, true)).toBe(true);
  expect(shouldPersistTerminalHistory(true, false)).toBe(false);
  expect(shouldPersistTerminalHistory(false, true)).toBe(false);
});
