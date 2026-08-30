import type { TerminalSession } from '../terminalSessions';
import type { PaneInfo } from '../types';
import { isCodexPane } from './codexSession';

export type ChatAgent = 'codex' | 'opencode';

const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]+$/;

export function isOpenCodePane(pane: PaneInfo | undefined): boolean {
  if (!pane) return false;
  if (pane.agent_session?.agent.toLowerCase() === 'opencode') return true;
  return [pane.agent, pane.display_agent].some(
    value =>
      typeof value === 'string' &&
      /(^|[^a-z])open\s*-?\s*code([^a-z]|$)/i.test(value),
  );
}

export function chatAgentForPane(pane: PaneInfo | undefined): ChatAgent | null {
  if (isCodexPane(pane)) return 'codex';
  if (isOpenCodePane(pane)) return 'opencode';
  return null;
}

export function activePaneForTerminal(
  panes: readonly PaneInfo[],
  sessions: readonly TerminalSession[],
  activeTerminalId: string | null,
): PaneInfo | undefined {
  const active = sessions.find(
    session => session.terminalId === activeTerminalId,
  );
  return panes.find(pane => pane.terminal_id === active?.terminalId);
}

export function agentChatControlState(
  pane: PaneInfo | undefined,
  busy: boolean,
  loading: boolean,
): { agent: ChatAgent; disabled: boolean; loading: boolean } | null {
  const agent = chatAgentForPane(pane);
  return agent ? { agent, disabled: busy || loading, loading } : null;
}

export function openCodeSessionIdForPane(
  pane: PaneInfo | undefined,
): string | null {
  const session = pane?.agent_session;
  if (
    session?.agent.toLowerCase() !== 'opencode' ||
    session.kind !== 'id'
  )
    return null;
  const value = session.value.trim();
  return OPENCODE_SESSION_ID.test(value) ? value : null;
}
