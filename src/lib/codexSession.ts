import { shellQuote } from './shell';
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

/** Parse the Codex row from `herdr integration status` without relying on paths. */
export function parseCodexIntegrationStatus(output: string): CodexIntegrationStatus {
  const match = output.match(/^codex:\s+(not installed|current|outdated|needs repair)(?:\s|\()/im);
  switch (match?.[1].toLowerCase()) {
    case 'not installed': return 'not-installed';
    case 'current': return 'current';
    case 'outdated': return 'outdated';
    case 'needs repair': return 'needs-repair';
    default: return 'unknown';
  }
}

export type CodexMissingIdentityAction = 'diagnose' | 'install' | 'unknown';

export function codexMissingIdentityAction(status: CodexIntegrationStatus): CodexMissingIdentityAction {
  if (status === 'current') return 'diagnose';
  if (status === 'unknown') return 'unknown';
  return 'install';
}

export function codexRolloutFindCommand(codexHome: string, sessionId: string): string {
  if (!isValidCodexSessionId(sessionId)) throw new Error('Invalid Codex session ID');
  const sessionsRoot = `${codexHome.replace(/\/+$/, '')}/sessions`;
  return `find ${shellQuote(sessionsRoot)} -type f -name ${shellQuote(`rollout-*-${sessionId}.jsonl`)} -print`;
}

export function parseCodexRolloutResolution(output: string, sessionId: string): string | null {
  if (!isValidCodexSessionId(sessionId)) throw new Error('Invalid Codex session ID');
  const paths = output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!paths.length) return null;
  const suffix = `-${sessionId}.jsonl`;
  const exact = paths.filter(path => path.endsWith(suffix));
  if (exact.length !== 1 || exact.length !== paths.length) {
    throw new Error(exact.length > 1 ? 'Multiple rollout files matched the Codex session ID' : 'Codex returned an invalid rollout path');
  }
  return exact[0];
}

export const CODEX_HISTORY_COMPLETE_RECORD = '__whip_codex_history_complete__';

export function codexRolloutStreamCommand(path: string): string {
  const quotedPath = shellQuote(path);
  const marker = shellQuote(JSON.stringify({ [CODEX_HISTORY_COMPLETE_RECORD]: true }));
  const script = [
    `size=$(wc -c < ${quotedPath}) || exit 1`,
    `head -c "$size" ${quotedPath} || exit 1`,
    `printf '\n%s\n' ${marker}`,
    `exec tail -c "+$((size + 1))" -F ${quotedPath}`,
  ].join('\n');
  return `exec /bin/sh -c ${shellQuote(script)}`;
}
