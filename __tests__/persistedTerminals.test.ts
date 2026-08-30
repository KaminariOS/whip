jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadPersistedTerminals,
  PersistedTerminalsWriter,
  savePersistedTerminals,
} from '../src/services/persistedTerminals';
import type { TerminalSessionsState } from '../src/terminalSessions';

const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);

beforeEach(() => {
  mockGetItem.mockReset();
  mockSetItem.mockReset();
});

test('loads raw terminal identity for Rust validation and focus reconciliation', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify({
    activeTerminalId: 'term-capsule',
    sessions: [{ terminalId: 'term-capsule', paneId: 'p-capsule', title: 'capsule' }],
  }));

  await expect(loadPersistedTerminals('thinker')).resolves.toMatchObject({
    activeTerminalId: 'term-capsule',
    terminalIds: ['term-capsule'],
  });
});

test('does not persist an ephemeral SSH fallback shell as a Herdr pane', async () => {
  const shell: TerminalSessionsState = {
    activeTerminalId: '__whip_ssh_shell__',
    sessions: [{
      terminalId: '__whip_ssh_shell__',
      paneId: '__whip_ssh_shell__',
      title: 'SSH shell',
      kind: 'ssh',
      status: 'connecting',
      reconnectAttempt: 0,
    }],
  };
  await savePersistedTerminals('fresh', shell);

  expect(mockSetItem).toHaveBeenCalledWith(
    'herdr.terminal.sessions.v1.fresh',
    JSON.stringify({ activeTerminalId: null, sessions: [] }),
  );
});

test('restores a pane font zoom across app restarts', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify({
    activeTerminalId: 'term-grok',
    sessions: [{
      terminalId: 'term-grok',
      paneId: 'p-grok',
      title: 'grok',
      fontSize: 10,
    }],
  }));

  const restored = await loadPersistedTerminals('thinker');

  expect(restored.fontSizes.get('term-grok')).toBe(10);
});

test('persists each pane font zoom with its restored terminal', async () => {
  await savePersistedTerminals('thinker', {
    activeTerminalId: 'term-grok',
    sessions: [{
      terminalId: 'term-grok',
      paneId: 'p-grok',
      title: 'grok',
      fontSize: 9,
      kind: 'herdr',
      status: 'connected',
      reconnectAttempt: 0,
    }],
  });

  expect(mockSetItem).toHaveBeenCalledWith(
    'herdr.terminal.sessions.v1.thinker',
    JSON.stringify({
      activeTerminalId: 'term-grok',
      sessions: [{ terminalId: 'term-grok', paneId: 'p-grok', title: 'grok', fontSize: 9 }],
    }),
  );
});

test('skips every host write when unrelated live-session state changes', async () => {
  const writer = new PersistedTerminalsWriter();
  const hostIds = ['alpha', 'beta', 'gamma'];
  const terminalStates = hostIds.map(hostId => ({
    activeTerminalId: `term-${hostId}`,
    sessions: [{
      terminalId: `term-${hostId}`,
      paneId: `pane-${hostId}`,
      title: hostId,
      kind: 'herdr' as const,
      status: 'connected' as const,
      reconnectAttempt: 0,
    }],
  }));

  await Promise.all(terminalStates.map((state, index) => (
    writer.saveIfChanged(
      `session-${index}`,
      hostIds[index],
      state,
    )
  )));
  mockSetItem.mockClear();

  await Promise.all(terminalStates.map((state, index) => (
    writer.saveIfChanged(
      `session-${index}`,
      hostIds[index],
      state,
    )
  )));

  expect(mockSetItem).not.toHaveBeenCalled();
});

test('tracks separate live sessions for the same saved host independently', async () => {
  const writer = new PersistedTerminalsWriter();
  const first = {
    activeTerminalId: 'term-1',
    sessions: [{
      terminalId: 'term-1',
      paneId: 'pane-1',
      title: 'first',
      status: 'connected' as const,
      reconnectAttempt: 0,
    }],
  };
  const second = {
    activeTerminalId: 'term-2',
    sessions: [{
      terminalId: 'term-2',
      paneId: 'pane-2',
      title: 'second',
      status: 'connected' as const,
      reconnectAttempt: 0,
    }],
  };
  await writer.saveIfChanged('live-1', 'thinker', first);
  await writer.saveIfChanged('live-2', 'thinker', second);
  mockSetItem.mockClear();

  await writer.saveIfChanged('live-1', 'thinker', first);
  await writer.saveIfChanged('live-2', 'thinker', second);

  expect(mockSetItem).not.toHaveBeenCalled();
});

test('skips terminal runtime-only changes but writes persisted terminal changes', async () => {
  const writer = new PersistedTerminalsWriter();
  const terminals = {
    activeTerminalId: 'term-grok',
    sessions: [{
      terminalId: 'term-grok',
      paneId: 'p-grok',
      title: 'grok',
      fontSize: 10,
      kind: 'herdr' as const,
      status: 'connecting' as const,
      reconnectAttempt: 0,
    }],
  };
  await writer.saveIfChanged('live-1', 'thinker', terminals);
  mockSetItem.mockClear();

  await expect(writer.saveIfChanged('live-1', 'thinker', {
    ...terminals,
    sessions: [{ ...terminals.sessions[0], status: 'connected' }],
  })).resolves.toBe(false);
  expect(mockSetItem).not.toHaveBeenCalled();

  await expect(writer.saveIfChanged('live-1', 'thinker', {
    ...terminals,
    sessions: [{ ...terminals.sessions[0], fontSize: 11 }],
  })).resolves.toBe(true);
  expect(mockSetItem).toHaveBeenCalledTimes(1);
});

test('retries an unchanged terminal value after its write fails', async () => {
  const writer = new PersistedTerminalsWriter();
  const terminals = {
    activeTerminalId: null,
    sessions: [],
  };
  mockSetItem.mockRejectedValueOnce(new Error('write unavailable'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  await expect(writer.saveIfChanged('live-1', 'thinker', terminals)).rejects.toThrow('write unavailable');
  mockSetItem.mockResolvedValueOnce();
  await expect(writer.saveIfChanged('live-1', 'thinker', terminals)).resolves.toBe(true);

  expect(mockSetItem).toHaveBeenCalledTimes(2);
  consoleError.mockRestore();
});

test('logs persisted-terminal getItem rejection without changing rejection behavior', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('read unavailable');
  mockGetItem.mockRejectedValueOnce(error);

  await expect(loadPersistedTerminals('thinker')).rejects.toBe(error);

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-read-failed',
  ));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    'herdr.terminal.sessions.v1.thinker',
  ));
  consoleError.mockRestore();
});

test('logs malformed persisted-terminal JSON and keeps returning empty state', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockGetItem.mockResolvedValueOnce('{not json');

  await expect(loadPersistedTerminals('thinker')).resolves.toEqual({
    terminalIds: [],
    activeTerminalId: null,
    fontSizes: new Map(),
  });
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-parse-failed',
  ));
  consoleError.mockRestore();
});

test('logs persisted-terminal write rejection without terminal titles', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('write unavailable');
  mockSetItem.mockRejectedValueOnce(error);

  await expect(savePersistedTerminals('thinker', {
    activeTerminalId: 'term-grok',
    sessions: [{
      terminalId: 'term-grok',
      paneId: 'p-grok',
      title: 'sensitive terminal title',
      kind: 'herdr',
      status: 'connected',
      reconnectAttempt: 0,
    }],
  })).rejects.toBe(error);

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-write-failed');
  expect(diagnostic).not.toContain('sensitive terminal title');
  consoleError.mockRestore();
});
