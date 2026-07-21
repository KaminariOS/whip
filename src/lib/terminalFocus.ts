export function serverFocusMatchesPendingPane(
  serverPaneId: string,
  pendingPaneId: string | null,
): boolean {
  return pendingPaneId === null || serverPaneId === pendingPaneId;
}
