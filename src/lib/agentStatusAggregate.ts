import type { AgentStatus } from '../types';

const AGENT_STATUS_PRIORITY: Record<AgentStatus, number> = {
  blocked: 5,
  done: 4,
  working: 3,
  idle: 2,
  unknown: 1,
};

/** Presentation-only aggregation across already authoritative native projections. */
export function aggregateAgentStatus(statuses: AgentStatus[]): AgentStatus {
  return statuses.reduce<AgentStatus>((aggregate, status) => (
    AGENT_STATUS_PRIORITY[status] > AGENT_STATUS_PRIORITY[aggregate] ? status : aggregate
  ), 'unknown');
}
