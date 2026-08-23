jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadPersistedTerminals, savePersistedTerminals } from '../src/services/persistedTerminals';
import { emptyTerminalSessions, openSshShellSession } from '../src/terminalSessions';
import type { HerdrSnapshot, PaneInfo } from '../src/types';

const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);

function pane(paneId: string, terminalId: string, tabId: string, focused = false): PaneInfo {
  return {
    pane_id: paneId,
    terminal_id: terminalId,
    workspace_id: 'w1',
    tab_id: tabId,
    focused,
    agent_status: 'idle',
    revision: 1,
  };
}

const capsule = pane('p-capsule', 'term-capsule', 't-capsule');
const grok = pane('p-grok', 'term-grok', 't-grok', true);
const snapshot: HerdrSnapshot = {
  server: { running: true },
  focused_workspace_id: 'w1',
  focused_tab_id: 't-grok',
  focused_pane_id: 'p-grok',
  agents: [],
  workspaces: [],
  tabs: [],
  panes: [capsule, grok],
  layouts: [],
};

beforeEach(() => {
  mockGetItem.mockReset();
  mockSetItem.mockReset();
});

test('makes the server-focused pane active instead of the previously persisted terminal', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify({
    activeTerminalId: 'term-capsule',
    sessions: [{ terminalId: 'term-capsule', paneId: 'p-capsule', title: 'capsule' }],
  }));

  await expect(loadPersistedTerminals('thinker', snapshot)).resolves.toMatchObject({
    activeTerminalId: 'term-grok',
    sessions: [
      { terminalId: 'term-capsule', paneId: 'p-capsule' },
      { terminalId: 'term-grok', paneId: 'p-grok' },
    ],
  });
});

test('does not persist an ephemeral SSH fallback shell as a Herdr pane', async () => {
  await savePersistedTerminals('fresh', openSshShellSession(emptyTerminalSessions));

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

  const restored = await loadPersistedTerminals('thinker', snapshot);

  expect(restored.sessions.find(session => session.terminalId === 'term-grok')).toMatchObject({
    fontSize: 10,
  });
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
