import type { PaneInfo } from '../types';

const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidCodexSessionId(value: string): boolean {
  return CODEX_SESSION_ID.test(value);
}

export function codexSessionIdForPane(pane: PaneInfo | undefined): string | null {
  const session = pane?.agent_session;
  if (!session || session.agent.toLowerCase() !== 'codex' || session.kind !== 'id') return null;
  const value = session.value.trim();
  return isValidCodexSessionId(value) ? value : null;
}

export function isCodexPane(pane: PaneInfo | undefined): boolean {
  if (!pane) return false;
  if (pane.agent_session?.agent.toLowerCase() === 'codex') return true;
  return [pane.agent, pane.display_agent]
    .some(value => typeof value === 'string' && /(^|[^a-z])codex([^a-z]|$)/i.test(value));
}

export type CodexChatAction = 'open' | 'setup' | 'unavailable';

export type CodexIntegrationStatus =
  | 'not-installed'
  | 'current'
  | 'outdated'
  | 'needs-repair'
  | 'unknown';

export function codexChatAction(pane: PaneInfo | undefined): CodexChatAction {
  if (!isCodexPane(pane)) return 'unavailable';
  return codexSessionIdForPane(pane) ? 'open' : 'setup';
}

export type CodexMissingIdentityAction = 'diagnose' | 'install' | 'unknown';

export function codexMissingIdentityAction(status: CodexIntegrationStatus): CodexMissingIdentityAction {
  if (status === 'current') return 'diagnose';
  if (status === 'unknown') return 'unknown';
  return 'install';
}
