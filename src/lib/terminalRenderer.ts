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

export type TerminalOfflineRestoreAction = 'hide' | 'preserve' | 'restore';

/** Decides whether a renderer needs cache reconstruction without using status. */
export function terminalOfflineRestoreAction(
  kind: TerminalSession['kind'],
  hasRenderedState: boolean,
  transcript: string,
): TerminalOfflineRestoreAction {
  if (kind === 'ssh') return 'hide';
  if (hasRenderedState || !transcript) return 'preserve';
  return 'restore';
}

/** Tracks whether a mounted xterm is warm or only showing cache reconstruction. */
export class TerminalRendererContentState {
  hasRenderedState = false;
  hasLiveState = false;
  snapshotVisible = false;

  restoreAction(kind: TerminalSession['kind'], transcript: string): TerminalOfflineRestoreAction {
    return terminalOfflineRestoreAction(kind, this.hasRenderedState, transcript);
  }

  restoredFromCache(): void {
    this.hasRenderedState = true;
    this.snapshotVisible = true;
  }

  receivedLiveFrame(): void {
    this.hasRenderedState = true;
    this.hasLiveState = true;
    this.snapshotVisible = false;
  }
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

/** Fit also requests a repaint after presenting an existing terminal. */
export function terminalResizeForcesNativeDispatch(source: 'fit' | 'xterm'): boolean {
  return source === 'fit';
}
