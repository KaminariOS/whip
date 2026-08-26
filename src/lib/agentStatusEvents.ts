import type { AgentInfo, AgentStatus, HerdrSnapshot, TabInfo } from '../types';

export function shouldNotifyAgentTransition(
  previous: AgentStatus | undefined,
  next: AgentStatus,
): boolean {
  if (!previous || previous === next) return false;
  // Herdr projects an unseen Idle detector state as Done. A public Idle state
  // is already seen, so clients should not reconstruct completion from it.
  return isAgentAlertingStatus(next);
}

export function isAgentAlertingStatus(status: AgentStatus): boolean {
  return status === 'blocked' || status === 'done';
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
