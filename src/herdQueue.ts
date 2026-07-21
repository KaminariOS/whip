import { tabNameForAgent } from './lib/agentStatusEvents';
import type { AgentInfo, TabInfo } from './types';

export interface HerdHostQueue {
  id: string;
  label: string;
  address: string;
  running: boolean;
  refreshing: boolean;
  agents: AgentInfo[];
  tabs: TabInfo[];
}

export interface HerdQueueAgent {
  hostId: string;
  hostLabel: string;
  agent: AgentInfo;
  tabLabel: string;
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
    queue.agents.map(agent => ({
      hostId: queue.id,
      hostLabel: queue.label,
      agent,
      tabLabel: tabNameForAgent(agent, queue.tabs),
    }))
  ));
}
