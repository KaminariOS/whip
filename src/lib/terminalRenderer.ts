import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalSession } from '../terminalSessions';
import type { PaneScrollInfo } from '../types';

export interface TerminalRenderTarget {
  key: string;
  hostSessionId: string;
  client: HerdrClient;
  session: TerminalSession;
  scroll?: PaneScrollInfo;
}

export function terminalRendererKey(hostSessionId: string, terminalId: string): string {
  return `${hostSessionId.length}:${hostSessionId}${terminalId}`;
}

const OFFLINE_NAVIGATION_INPUTS = new Set([
  '\u001b[A', '\u001bOA',
  '\u001b[B', '\u001bOB',
  '\u001b[5~', '\u001b[1;5A',
  '\u001b[6~', '\u001b[1;5B',
  '\u001b[H', '\u001bOH',
  '\u001b[F', '\u001bOF',
]);

export function isOfflineTerminalNavigationInput(data: string): boolean {
  return OFFLINE_NAVIGATION_INPUTS.has(data);
}

export interface TerminalScrollbackMode {
  localScrollback: boolean;
  offlineScrollback: boolean;
}

export function terminalScrollbackMode(
  session: Pick<TerminalSession, 'kind' | 'status'>,
): TerminalScrollbackMode {
  return {
    localScrollback: session.kind === 'ssh',
    offlineScrollback: session.status !== 'connected',
  };
}

export function directTerminalKeyboardEnabled(
  status: TerminalSession['status'],
  requested: boolean,
  composerOpen: boolean,
): boolean {
  return status === 'connected' && requested && !composerOpen;
}
