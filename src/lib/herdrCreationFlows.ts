import type {
  HostRuntimeConnection,
  RuntimeTabCreationResult,
  RuntimeTabLaunch,
  RuntimeTabLaunchFailure,
} from 'react-native-whip-ssh';

import type { WorkspaceInfo } from '../types';

export type TabCreationResult = RuntimeTabCreationResult;
export type TabLaunchIntent = RuntimeTabLaunch;

export class CommandLaunchPartialFailure extends Error {
  constructor(
    readonly created: TabCreationResult,
    readonly launchType: 'agent' | 'command',
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const action = launchType === 'agent' ? 'agent launch' : 'command input';
    super(`Tab ${created.tab.label || created.tab.tab_id} was created, but ${action} failed: ${detail}`);
    this.name = 'CommandLaunchPartialFailure';
  }
}

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
  runtime: Pick<HostRuntimeConnection, 'createTabWithLaunch'>,
  workspaceId: string,
  tabName: string,
  launch: TabLaunchIntent,
  open: (created: TabCreationResult) => void,
): Promise<TabCreationResult> {
  try {
    const created = await runtime.createTabWithLaunch(workspaceId, tabName, launch);
    open(created);
    return created;
  } catch (error) {
    const failure = error as RuntimeTabLaunchFailure;
    if (
      failure.code === 'TAB_LAUNCH_FAILED'
      && failure.created
      && failure.launchType
    ) {
      const partial = new CommandLaunchPartialFailure(
        failure.created,
        failure.launchType,
        error,
      );
      open(partial.created);
      throw partial;
    }
    throw error;
  }
}
