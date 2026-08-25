jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), removeItem: jest.fn(), setItem: jest.fn() },
}));

import type AsyncStorageType from '@react-native-async-storage/async-storage';

function mockedStorage(): jest.Mocked<typeof AsyncStorageType> {
  return require('@react-native-async-storage/async-storage').default as jest.Mocked<
    typeof AsyncStorageType
  >;
}

beforeEach(() => {
  jest.resetModules();
});

test('parses only bounded valid latency diagnostic entries', () => {
  const { latencyDiagnosticsFromStorage } =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');
  const valid = {
    id: 'one',
    kind: 'slow',
    timestamp: '2026-08-25T12:00:00.000Z',
    sessionId: 'host-1',
    latencyMs: 600,
    sshRttMs: 599.8,
    totalMs: 604.2,
    dispatchMs: 4.4,
  };

  expect(latencyDiagnosticsFromStorage(JSON.stringify([
    valid,
    { ...valid, id: 'bad-time', timestamp: 'not-a-date' },
    { ...valid, id: 'bad-number', sshRttMs: -1 },
  ]))).toEqual([valid]);
  expect(latencyDiagnosticsFromStorage('{')).toEqual([]);
});

test('persists only slow samples and first-class failure details', async () => {
  const storage = mockedStorage();
  storage.getItem.mockResolvedValue(null);
  const diagnostics =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');
  await diagnostics.setLatencyDiagnosticsEnabled(true);

  await expect(diagnostics.recordSlowHostLatency('host-1', {
    latencyMs: 4,
    sshRttMs: 4,
    totalMs: 5,
    dispatchMs: 1,
  })).resolves.toBe(false);
  await expect(diagnostics.recordSlowHostLatency('host-1', {
    latencyMs: 4,
    sshRttMs: 4,
    totalMs: 604,
    dispatchMs: 600,
  })).resolves.toBe(true);
  await diagnostics.recordHostLatencyFailure('host-1', 10_000, 'timed\n out');

  expect(diagnostics.getLatencyDiagnosticEntries()).toMatchObject([
    { kind: 'slow', sshRttMs: 4, totalMs: 604, dispatchMs: 600 },
    { kind: 'failure', totalMs: 10_000, error: 'timed out' },
  ]);
  await diagnostics.flushLatencyDiagnosticWrites();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(storage.setItem.mock.calls[0][1])).toHaveLength(2);
  expect(diagnostics.formatLatencyDiagnostics()).toContain(
    'SLOW session=host-1 latency=4ms ssh=4ms total=604ms dispatch=600ms',
  );
});

test('retains at most the latest 100 anomalous samples', async () => {
  mockedStorage().getItem.mockResolvedValue(null);
  const diagnostics =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');
  await diagnostics.setLatencyDiagnosticsEnabled(true);

  for (let index = 0; index < 105; index += 1) {
    await diagnostics.recordSlowHostLatency(`host-${index}`, {
      latencyMs: 200,
      sshRttMs: 200,
      totalMs: 201,
      dispatchMs: 1,
    });
  }

  const entries = diagnostics.getLatencyDiagnosticEntries();
  expect(entries).toHaveLength(100);
  expect(entries[0]).toMatchObject({ sessionId: 'host-5' });
  expect(entries[99]).toMatchObject({ sessionId: 'host-104' });
  await diagnostics.flushLatencyDiagnosticWrites();
});

test('does not collect while disabled and removes previously persisted diagnostics', async () => {
  const storage = mockedStorage();
  const diagnostics =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');

  await expect(diagnostics.recordSlowHostLatency('host-1', {
    latencyMs: 500,
    sshRttMs: 500,
    totalMs: 501,
    dispatchMs: 1,
  })).resolves.toBe(false);
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(diagnostics.getLatencyDiagnosticEntries()).toEqual([]);

  await diagnostics.setLatencyDiagnosticsEnabled(false);
  expect(storage.removeItem).toHaveBeenCalledWith(
    diagnostics.LATENCY_DIAGNOSTICS_STORAGE_KEY,
  );
  expect(storage.setItem).not.toHaveBeenCalled();
});
