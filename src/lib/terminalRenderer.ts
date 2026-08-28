import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalSession } from '../terminalSessions';
import type { PaneScrollInfo } from '../types';
import type { VisualContentInsets } from './floatingChrome';

export interface TerminalVisualViewport {
  /** Floating chrome that may visually cover terminal content. */
  insets: VisualContentInsets;
  /** Bottom space historically excluded from xterm's fitted geometry. */
  geometryBottomInset: number;
  /** RN's last-known xterm buffer mode; the renderer also checks its live buffer. */
  alternateScreen?: boolean;
  /** Remote scroll position; local/offline xterm buffers derive this in the renderer. */
  scroll?: PaneScrollInfo;
}

export interface TerminalVisualOffsetInput extends TerminalVisualViewport {
  alternateScreen: boolean;
  boundaryPreference?: 'top' | 'bottom';
  viewportHeight?: number;
}

/**
 * Places normal-buffer content at its visual boundaries without adding terminal
 * rows. Full-screen applications always retain their real PTY coordinates.
 */
export function terminalVisualOffset({
  alternateScreen,
  boundaryPreference = 'top',
  geometryBottomInset,
  insets,
  scroll,
  viewportHeight,
}: TerminalVisualOffsetInput): number {
  if (alternateScreen) return 0;

  const top = Math.max(0, insets.top);
  const bottomAllowance = Math.max(
    0,
    insets.bottom - Math.max(0, geometryBottomInset),
  );
  if (!scroll || scroll.max_offset_from_bottom <= 0) {
    return boundaryPreference === 'top' ? top : -bottomAllowance;
  }

  const maximum = Math.max(0, scroll.max_offset_from_bottom);
  const offset = Math.max(0, Math.min(maximum, scroll.offset_from_bottom));
  if (offset >= maximum) return top;
  if (offset <= 0) return -bottomAllowance;

  const cellHeight = Math.max(
    1,
    (viewportHeight ?? scroll.viewport_rows) / scroll.viewport_rows,
  );
  if (boundaryPreference === 'top') {
    return Math.max(0, top - (maximum - offset) * cellHeight);
  }
  const bottomReveal = Math.max(0, bottomAllowance - offset * cellHeight);
  return bottomReveal > 0 ? -bottomReveal : 0;
}

export interface TerminalRenderTarget {
  key: string;
  hostSessionId: string;
  client: TerminalRuntimeClient;
  session: TerminalSession;
  scroll?: PaneScrollInfo;
}

export type TerminalRuntimeClient = Pick<
  HerdrClient,
  | 'clickTerminal'
  | 'closeTerminal'
  | 'closeTerminalBridge'
  | 'detachTerminal'
  | 'isTerminalBridgeRetained'
  | 'openTerminal'
  | 'pasteIntoPane'
  | 'releaseTerminal'
  | 'resizeTerminal'
  | 'scrollTerminal'
  | 'snapshot'
  | 'submitPastesToPane'
  | 'writeToTerminal'
>;

export function terminalRendererKey(
  hostSessionId: string,
  terminalId: string,
): string {
  return `${hostSessionId.length}:${hostSessionId}${terminalId}`;
}

const OFFLINE_NAVIGATION_INPUTS = new Set([
  '\u001b[A',
  '\u001bOA',
  '\u001b[B',
  '\u001bOB',
  '\u001b[5~',
  '\u001b[1;5A',
  '\u001b[6~',
  '\u001b[1;5B',
  '\u001b[H',
  '\u001bOH',
  '\u001b[F',
  '\u001bOF',
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

  restoreAction(
    kind: TerminalSession['kind'],
    transcript: string,
  ): TerminalOfflineRestoreAction {
    return terminalOfflineRestoreAction(
      kind,
      this.hasRenderedState,
      transcript,
    );
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
export function terminalResizeForcesNativeDispatch(
  source: 'fit' | 'xterm',
): boolean {
  return source === 'fit';
}
