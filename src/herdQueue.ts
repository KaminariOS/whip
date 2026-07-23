import { tabNameForAgent } from './lib/agentStatusEvents';
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

  return scopedQueues.flatMap(queue => (
    queue.agents
      .filter(agent => !resolvedWorkspaceId || agent.workspace_id === resolvedWorkspaceId)
      .map(agent => {
        const tabLabel = tabNameForAgent(agent, queue.tabs);
        const workspaceLabel = queue.workspaces
          .find(workspace => workspace.workspace_id === agent.workspace_id)
          ?.label.trim() || agent.workspace_id;
        const hasMultipleTabs = queue.tabs.filter(
          tab => tab.workspace_id === agent.workspace_id,
        ).length > 1;

        return {
          hostId: queue.id,
          hostLabel: queue.label,
          agent,
          tabLabel,
          primaryLabel: hasMultipleTabs ? `${workspaceLabel} · ${tabLabel}` : workspaceLabel,
        };
      })
  ));
}
