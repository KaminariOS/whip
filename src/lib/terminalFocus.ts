import type { PaneInfo, TabInfo } from '../types';

export interface CreatedTabFocusResult {
  tab: TabInfo;
  root_pane: PaneInfo;
}

export interface TerminalSelectionResources {
  tabs: readonly TabInfo[];
  panes: readonly PaneInfo[];
}

/** Keep a successful creation selectable until both resources reach the snapshot. */
export function includePendingCreatedSelection(
  resources: TerminalSelectionResources,
  pending: CreatedTabFocusResult | null,
): TerminalSelectionResources {
  if (!pending) return resources;
  return {
    tabs: resources.tabs.some(tab => tab.tab_id === pending.tab.tab_id)
      ? resources.tabs
      : [...resources.tabs, pending.tab],
    panes: resources.panes.some(pane => pane.pane_id === pending.root_pane.pane_id)
      ? resources.panes
      : [...resources.panes, pending.root_pane],
  };
}

/** Release local creation authority only after the snapshot contains its tab and root pane. */
export function reconcilePendingCreatedSelection(
  pending: CreatedTabFocusResult | null,
  resources: TerminalSelectionResources,
): CreatedTabFocusResult | null {
  if (!pending) return null;
  const tabConfirmed = resources.tabs.some(tab => (
    tab.tab_id === pending.tab.tab_id
      && tab.workspace_id === pending.tab.workspace_id
  ));
  const paneConfirmed = resources.panes.some(pane => (
    pane.pane_id === pending.root_pane.pane_id
      && pane.terminal_id === pending.root_pane.terminal_id
      && pane.tab_id === pending.tab.tab_id
  ));
  return tabConfirmed && paneConfirmed ? null : pending;
}

/** Couple a locally requested tab selection to its authoritative root terminal. */
export function activateCreatedTabLocally(
  created: CreatedTabFocusResult,
  actions: {
    select: (workspaceId: string, tabId: string) => void;
    terminalSelectionStarted: (terminalId: string) => void;
    activateTerminal: (pane: PaneInfo) => void;
  },
): void {
  actions.select(created.tab.workspace_id, created.tab.tab_id);
  actions.terminalSelectionStarted(created.root_pane.terminal_id);
  actions.activateTerminal(created.root_pane);
}

export function serverFocusMatchesPendingPane(
  serverPaneId: string,
  pendingPaneId: string | null,
): boolean {
  return pendingPaneId === null || serverPaneId === pendingPaneId;
}

/** Keep a visible terminal pinned to its local selection while remote focus settles. */
export function shouldFollowServerTerminalFocus(
  visible: boolean,
  activePaneId: string | null,
): boolean {
  return !visible || !activePaneId;
}
