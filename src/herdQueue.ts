import { tabNameForAgent } from './lib/agentStatusEvents';
import type { AgentInfo, TabInfo, WorkspaceInfo } from './types';

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

export function agentsForHerdFilter(
  queues: HerdHostQueue[],
  selectedHostId: string | null,
): HerdQueueAgent[] {
  return queuesForHerdFilter(queues, selectedHostId).flatMap(queue => (
    queue.agents.map(agent => {
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
