import type { WorkspaceInfo } from '../types';
import {
  CommandLaunchPartialFailure,
  type HerdrClient,
  type TabLaunchIntent,
  type TabCreationResult,
} from '../services/HerdrClient';

export async function createWorkspaceAndSelect(
  create: () => Promise<WorkspaceInfo>,
  filter: (workspaceId: string) => void,
  select: (workspaceId: string) => void,
): Promise<WorkspaceInfo> {
  const workspace = await create();
  filter(workspace.workspace_id);
  select(workspace.workspace_id);
  return workspace;
}

/** Open the authoritative pane even when launch failed after tab.create. */
export async function launchTabAndOpenCreatedTab(
  client: Pick<HerdrClient, 'createTabWithLaunch'>,
  workspaceId: string,
  tabName: string,
  launch: TabLaunchIntent,
  open: (created: TabCreationResult) => void,
): Promise<TabCreationResult> {
  try {
    const created = await client.createTabWithLaunch(workspaceId, tabName, launch);
    open(created);
    return created;
  } catch (error) {
    if (error instanceof CommandLaunchPartialFailure) open(error.created);
    throw error;
  }
}
