import type { EventData } from '../generated/herdrApi';
import type { AgentInfo, AgentStatus, HerdrSnapshot, TabInfo } from '../types';

type PaneAgentStatusChangedEvent = Extract<
  EventData,
  { type: 'pane_agent_status_changed' }
>;

export type AgentStatusUpdate = Omit<
  PaneAgentStatusChangedEvent,
  'type' | 'pane_id' | 'workspace_id'
>;

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
): boolean {
  if (!previous || previous === next) return false;
  // Herdr projects an unseen Idle detector state as Done. A public Idle state
  // is already seen, so clients should not reconstruct completion from it.
  return next === 'blocked' || next === 'done';
}

/**
 * Read the status that currently drives the visible UI before applying an
 * incoming event or snapshot. The runtime cache is only a fallback: refreshes
 * and events can race, so it must not suppress a transition the user can see.
 */
export function previousVisibleAgentStatus(
  snapshot: Pick<HerdrSnapshot, 'agents' | 'panes'> | undefined,
  paneId: string,
  fallback?: AgentStatus,
): AgentStatus | undefined {
  return snapshot?.agents.find(agent => agent.pane_id === paneId)?.agent_status
    ?? snapshot?.panes.find(pane => pane.pane_id === paneId)?.agent_status
    ?? fallback;
}

export function foregroundUsesBriefAlerts(appHasFocus: boolean): boolean {
  return appHasFocus;
}

export function tabNameForAgent(
  agent: Pick<AgentInfo, 'tab_id'>,
  tabs: TabInfo[],
): string {
  const label = tabs.find(tab => tab.tab_id === agent.tab_id)?.label.trim();
  return label || agent.tab_id;
}

export function agentNotificationTitle(
  agent: AgentInfo,
  tabName?: string,
  labels?: { needsYou: (name: string) => string; finished: (name: string) => string },
): string {
  const name = agent.display_agent || agent.name || agent.agent || agent.pane_id;
  const action = agent.agent_status === 'blocked'
    ? labels?.needsYou(name) || `${name} needs you`
    : labels?.finished(name) || `${name} finished`;
  const label = tabName?.trim();
  return label ? `${label} · ${action}` : action;
}

export function agentFromStatusEvent(
  current: AgentInfo,
  data: AgentStatusUpdate,
): AgentInfo {
  const next = { ...current, agent_status: data.agent_status };
  for (const field of ['agent', 'title', 'display_agent'] as const) {
    const value = data[field];
    if (value !== undefined) next[field] = value;
  }
  if (data.state_labels) next.state_labels = data.state_labels;
  return next;
}
