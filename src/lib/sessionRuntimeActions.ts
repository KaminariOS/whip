import { preferredWorkspacePane } from '../liveHostSessions';
import type { HerdrClient } from '../services/HerdrClient';
import type { HerdrSnapshot, PaneInfo } from '../types';

export type SemanticHerdrMutation =
  | { type: 'close-tab'; tabId: string }
  | { type: 'close-workspace'; workspaceId: string }
  | { type: 'rename-workspace'; workspaceId: string; name: string };

type SemanticMutationClient = Pick<
  HerdrClient,
  'closeTab' | 'closeWorkspace' | 'renameWorkspace'
>;

export async function runSemanticHerdrMutation(
  client: SemanticMutationClient,
  mutation: SemanticHerdrMutation,
): Promise<void> {
  switch (mutation.type) {
    case 'close-tab':
      await client.closeTab(mutation.tabId);
      return;
    case 'close-workspace':
      await client.closeWorkspace(mutation.workspaceId);
      return;
    case 'rename-workspace':
      await client.renameWorkspace(mutation.workspaceId, mutation.name);
  }
}

export async function startNativeHerdrServer(
  client: Pick<HerdrClient, 'startServer'>,
): Promise<void> {
  await client.startServer();
}

export async function openWorkspaceFromProjection({
  activatePaneTerminal,
  client,
  emptyWorkspaceError,
  openPaneTerminal,
  refreshSnapshot,
  selectTerminal,
  selectWorkspace,
  snapshot,
  workspaceId,
}: {
  activatePaneTerminal: (pane: PaneInfo) => void;
  client: Pick<HerdrClient, 'focusWorkspace'>;
  emptyWorkspaceError: () => Error;
  openPaneTerminal: (pane: PaneInfo) => void;
  refreshSnapshot: () => Promise<HerdrSnapshot | null>;
  selectTerminal: () => void;
  selectWorkspace: () => void;
  snapshot: HerdrSnapshot | undefined;
  workspaceId: string;
}): Promise<void> {
  const pane = snapshot
    ? preferredWorkspacePane(snapshot, workspaceId)
    : undefined;
  selectWorkspace();
  if (pane) {
    openPaneTerminal(pane);
    return;
  }

  selectTerminal();
  await client.focusWorkspace(workspaceId);
  const refreshed = await refreshSnapshot();
  const refreshedPane = refreshed
    ? preferredWorkspacePane(refreshed, workspaceId)
    : undefined;
  if (!refreshedPane) throw emptyWorkspaceError();
  activatePaneTerminal(refreshedPane);
}
