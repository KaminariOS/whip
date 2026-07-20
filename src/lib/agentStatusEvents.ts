import type { AgentInfo, AgentStatus, TabInfo } from '../types';

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
  suppressActiveTabNotifications: boolean,
): boolean {
  if (!previous || previous === next || suppressActiveTabNotifications) return false;
  // Herdr projects an unseen Idle detector state as Done. A public Idle state
  // is already seen, so clients should not reconstruct completion from it.
  return next === 'blocked' || next === 'done';
}

export function activeTabSuppressesNotifications(
  agent: Pick<AgentInfo, 'tab_id'>,
  tabs: TabInfo[],
  appHasFocus: boolean,
  hostIsActive: boolean,
): boolean {
  return appHasFocus
    && hostIsActive
    && tabs.some(tab => tab.tab_id === agent.tab_id && tab.focused);
}

export function tabNameForAgent(
  agent: Pick<AgentInfo, 'tab_id'>,
  tabs: TabInfo[],
): string {
  const label = tabs.find(tab => tab.tab_id === agent.tab_id)?.label.trim();
  return label || agent.tab_id;
}

export function agentNotificationTitle(agent: AgentInfo, tabName?: string): string {
  const name = agent.display_agent || agent.name || agent.agent || agent.pane_id;
  const action = agent.agent_status === 'blocked' ? `${name} needs you` : `${name} finished`;
  const label = tabName?.trim();
  return label ? `${label} · ${action}` : action;
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
