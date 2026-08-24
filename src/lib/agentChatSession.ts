import type { PaneInfo } from '../types';
import { isCodexPane } from './codexSession';

export type ChatAgent = 'codex' | 'opencode';

const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]+$/;

export function isOpenCodePane(pane: PaneInfo | undefined): boolean {
  if (!pane) return false;
  if (pane.agent_session?.agent.toLowerCase() === 'opencode') return true;
  return [pane.agent, pane.display_agent]
    .some(value => typeof value === 'string' && /(^|[^a-z])open\s*-?\s*code([^a-z]|$)/i.test(value));
}

export function chatAgentForPane(pane: PaneInfo | undefined): ChatAgent | null {
  if (isCodexPane(pane)) return 'codex';
  if (isOpenCodePane(pane)) return 'opencode';
  return null;
}

export function openCodeSessionIdForPane(pane: PaneInfo | undefined): string | null {
  const session = pane?.agent_session;
  if (!session || session.agent.toLowerCase() !== 'opencode' || session.kind !== 'id') return null;
  const value = session.value.trim();
  return OPENCODE_SESSION_ID.test(value) ? value : null;
}
