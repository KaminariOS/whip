import type { AgentInfo, AgentStatus, TabInfo, WorkspaceInfo } from './types';

export interface HerdHostQueue {
  id: string;
  label: string;
  address: string;
  running: boolean;
  refreshing: boolean;
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
}

export interface HerdQueueAgent {
  hostId: string;
  hostLabel: string;
  agent: AgentInfo;
  tabLabel: string;
  primaryLabel: string;
}

const AGENT_STATUS_SORT_PRIORITY: Record<AgentStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

export function compareAgentStatusPriority(a: AgentStatus, b: AgentStatus): number {
  return AGENT_STATUS_SORT_PRIORITY[a] - AGENT_STATUS_SORT_PRIORITY[b];
}

export function orderByAgentStatusPriority<T>(
  items: readonly T[],
  statusOf: (item: T) => AgentStatus,
  stateChangeSequenceOf?: (item: T) => number | undefined,
): T[] {
  return [...items].sort((a, b) => {
    const statusPriority = compareAgentStatusPriority(statusOf(a), statusOf(b));
    if (statusPriority !== 0 || !stateChangeSequenceOf) return statusPriority;

    const aSequence = stateChangeSequenceOf(a);
    const bSequence = stateChangeSequenceOf(b);
    if (aSequence === bSequence) return 0;
    if (aSequence === undefined) return 1;
    if (bSequence === undefined) return -1;
    return aSequence > bSequence ? -1 : 1;
  });
}

export function tabAgentStateChangeSequence(
  tab: Pick<TabInfo, 'tab_id' | 'agent_status'>,
  agents: readonly AgentInfo[],
): number | undefined {
  let latest: number | undefined;
  for (const agent of agents) {
    if (
      agent.tab_id !== tab.tab_id
      || agent.agent_status !== tab.agent_status
      || agent.state_change_seq === undefined
    ) {
      continue;
    }
    latest = latest === undefined
      ? agent.state_change_seq
      : Math.max(latest, agent.state_change_seq);
  }
  return latest;
}

export function resolveHerdHostFilter(
  queues: HerdHostQueue[],
  requestedHostId: string | null,
): string | null {
  return requestedHostId && queues.some(queue => queue.id === requestedHostId)
    ? requestedHostId
    : null;
}

export function queuesForHerdFilter(
  queues: HerdHostQueue[],
  selectedHostId: string | null,
): HerdHostQueue[] {
  const resolved = resolveHerdHostFilter(queues, selectedHostId);
  return resolved ? queues.filter(queue => queue.id === resolved) : queues;
}

export function resolveHerdWorkspaceFilter(
  queue: HerdHostQueue | undefined,
  requestedWorkspaceId: string | null,
): string | null {
  return requestedWorkspaceId && queue?.workspaces.some(
    workspace => workspace.workspace_id === requestedWorkspaceId,
  )
    ? requestedWorkspaceId
    : null;
}

export function agentsForHerdFilter(
  queues: HerdHostQueue[],
  selectedHostId: string | null,
  selectedWorkspaceId: string | null = null,
): HerdQueueAgent[] {
  const scopedQueues = queuesForHerdFilter(queues, selectedHostId);
  const selectedQueue = resolveHerdHostFilter(queues, selectedHostId)
    ? scopedQueues[0]
    : undefined;
  const resolvedWorkspaceId = resolveHerdWorkspaceFilter(selectedQueue, selectedWorkspaceId);

  return scopedQueues.flatMap(queue => {
    const tabsById = new Map(queue.tabs.map(tab => [tab.tab_id, tab]));
    const workspacesById = new Map(
      queue.workspaces.map(workspace => [workspace.workspace_id, workspace]),
    );
    const tabCountsByWorkspace = new Map<string, number>();
    for (const tab of queue.tabs) {
      tabCountsByWorkspace.set(
        tab.workspace_id,
        (tabCountsByWorkspace.get(tab.workspace_id) ?? 0) + 1,
      );
    }

    return queue.agents
      .filter(agent => !resolvedWorkspaceId || agent.workspace_id === resolvedWorkspaceId)
      .map(agent => {
        const tabLabel = tabsById.get(agent.tab_id)?.label.trim() || agent.tab_id;
        const workspaceLabel = workspacesById.get(agent.workspace_id)?.label.trim()
          || agent.workspace_id;
        const hasMultipleTabs = (tabCountsByWorkspace.get(agent.workspace_id) ?? 0) > 1;

        return {
          hostId: queue.id,
          hostLabel: queue.label,
          agent,
          tabLabel,
          primaryLabel: hasMultipleTabs ? `${workspaceLabel} · ${tabLabel}` : workspaceLabel,
        };
      });
  });
}
