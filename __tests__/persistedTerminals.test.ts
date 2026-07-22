jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadPersistedTerminals } from '../src/services/persistedTerminals';
import type { HerdrSnapshot, PaneInfo } from '../src/types';

const mockGetItem = jest.mocked(AsyncStorage.getItem);

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

beforeEach(() => mockGetItem.mockReset());

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
