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

export function codexRolloutMetadataCommand(path: string): string {
  const quotedPath = shellQuote(path);
  return `stat -c '%d:%i %s' ${quotedPath} 2>/dev/null || stat -f '%d:%i %z' ${quotedPath}`;
}

export interface CodexRolloutMetadata {
  fileId: string;
  size: number;
}

export function parseCodexRolloutMetadata(output: string): CodexRolloutMetadata {
  const match = output.trim().match(/^(\d+:\d+)\s+(\d+)$/);
  if (!match) throw new Error('Codex returned invalid rollout metadata');
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size)) throw new Error('Codex returned invalid rollout metadata');
  return { fileId: match[1], size };
}

/** Streams only raw rollout bytes, starting immediately after the committed byte cursor. */
export function codexRolloutStreamCommand(path: string, startOffset = 0): string {
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) throw new Error('Invalid Codex rollout cursor');
  return `exec tail -c ${shellQuote(`+${startOffset + 1}`)} -F ${shellQuote(path)}`;
}
