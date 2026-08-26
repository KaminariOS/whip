import {
  activateCreatedTabLocally,
  serverFocusMatchesPendingPane,
  shouldFollowServerTerminalFocus,
} from '../src/lib/terminalFocus';
import { emptyTerminalSessions, openTerminalSession } from '../src/terminalSessions';
import type { PaneInfo, TabInfo } from '../src/types';

const createdTab = {
  tab: {
    tab_id: 'tab-new',
    workspace_id: 'workspace-1',
    number: 2,
    label: 'New tab',
    focused: true,
    pane_count: 1,
    agent_status: 'idle',
  } as TabInfo,
  root_pane: {
    pane_id: 'pane-new',
    terminal_id: 'terminal-new',
    workspace_id: 'workspace-1',
    tab_id: 'tab-new',
    focused: true,
    agent_status: 'idle',
    revision: 0,
  } as PaneInfo,
};

test('locally created tabs select the tab and activate the returned root terminal together', () => {
  let selectedWorkspaceId = 'workspace-1';
  let selectedTabId = 'tab-old';
  let terminals = openTerminalSession(emptyTerminalSessions, {
    ...createdTab.root_pane,
    pane_id: 'pane-old',
    terminal_id: 'terminal-old',
    tab_id: 'tab-old',
  });
  const terminalSelectionStarted = jest.fn();

  activateCreatedTabLocally(createdTab, {
    select: (workspaceId, tabId) => {
      selectedWorkspaceId = workspaceId;
      selectedTabId = tabId;
    },
    terminalSelectionStarted,
    activateTerminal: pane => {
      terminals = openTerminalSession(terminals, pane);
    },
  });

  expect(selectedWorkspaceId).toBe('workspace-1');
  expect(selectedTabId).toBe('tab-new');
  expect(terminals.activeTerminalId).toBe('terminal-new');
  expect(terminalSelectionStarted).toHaveBeenCalledWith('terminal-new');
});

test('ignores stale server focus while a selected pane is pending', () => {
  expect(serverFocusMatchesPendingPane('previous-pane', 'selected-pane')).toBe(false);
  expect(serverFocusMatchesPendingPane('selected-pane', 'selected-pane')).toBe(true);
});

test('follows server focus when there is no pending user selection', () => {
  expect(serverFocusMatchesPendingPane('remote-pane', null)).toBe(true);
});

test('does not let startup focus updates steal an already visible terminal tab', () => {
  expect(shouldFollowServerTerminalFocus(true, 'selected-pane')).toBe(false);
  expect(shouldFollowServerTerminalFocus(false, 'selected-pane')).toBe(true);
  expect(shouldFollowServerTerminalFocus(true, null)).toBe(true);
});
