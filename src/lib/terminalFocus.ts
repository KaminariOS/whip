import type { PaneInfo, TabInfo } from '../types';

export interface CreatedTabFocusResult {
  tab: TabInfo;
  root_pane: PaneInfo;
}

/** Couple a locally requested tab selection to its authoritative root terminal. */
export function activateCreatedTabLocally<Created extends CreatedTabFocusResult>(
  created: Created,
  actions: {
    select: (workspaceId: string, tabId: string) => void;
    terminalSelectionStarted: (terminalId: string) => void;
    project: (created: Created) => void;
    activateTerminal: (pane: PaneInfo) => void;
  },
): void {
  actions.select(created.tab.workspace_id, created.tab.tab_id);
  actions.terminalSelectionStarted(created.root_pane.terminal_id);
  actions.project(created);
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
