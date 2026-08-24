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
