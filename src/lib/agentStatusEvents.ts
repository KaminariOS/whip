import type { AgentInfo, AgentStatus } from '../types';

const AGENT_STATUSES = new Set<AgentStatus>([
  'idle',
  'working',
  'blocked',
  'done',
  'unknown',
]);

export function agentStatusFromEvent(value: unknown): AgentStatus | null {
  return typeof value === 'string' && AGENT_STATUSES.has(value as AgentStatus)
    ? value as AgentStatus
    : null;
}

export function shouldNotifyAgentTransition(
  previous: AgentStatus | undefined,
  next: AgentStatus,
  appIsBackgrounded: boolean,
): boolean {
  if (!previous || previous === next) return false;
  if (next === 'blocked' || next === 'done') return true;
  return appIsBackgrounded
    && next === 'idle'
    && (previous === 'working' || previous === 'blocked');
}

export function agentFromStatusEvent(
  current: AgentInfo,
  data: Record<string, unknown>,
): AgentInfo | null {
  const agentStatus = agentStatusFromEvent(data.agent_status);
  if (!agentStatus) return null;

  const next = { ...current, agent_status: agentStatus };
  for (const field of ['agent', 'title', 'display_agent', 'custom_status'] as const) {
    if (typeof data[field] === 'string') next[field] = data[field];
  }
  if (isStringRecord(data.state_labels)) next.state_labels = data.state_labels;
  return next;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(item => typeof item === 'string');
}
