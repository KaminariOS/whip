export type TerminalTabSwipeDirection = -1 | 1;

const SWIPE_CAPTURE_DISTANCE = 10;
const SWIPE_AXIS_BIAS = 1.2;
const SWIPE_COMMIT_FRACTION = 0.25;
const SWIPE_COMMIT_VELOCITY = 0.45;

export function terminalTabSwipeDirection(
  dx: number,
  dy: number,
  activeTouches: number,
): TerminalTabSwipeDirection | null {
  if (activeTouches !== 1) return null;
  if (Math.abs(dx) < SWIPE_CAPTURE_DISTANCE) return null;
  if (Math.abs(dx) <= Math.abs(dy) * SWIPE_AXIS_BIAS) return null;
  return dx < 0 ? 1 : -1;
}

export function neighborTabIndex(
  currentIndex: number,
  tabCount: number,
  direction: TerminalTabSwipeDirection,
): number | null {
  const nextIndex = currentIndex + direction;
  return nextIndex >= 0 && nextIndex < tabCount ? nextIndex : null;
}

export function terminalTabSwipeOffset(
  dx: number,
  width: number,
  direction: TerminalTabSwipeDirection,
): number {
  if (direction === 1) return Math.max(-width, Math.min(0, dx));
  return Math.min(width, Math.max(0, dx));
}

export function shouldCommitTerminalTabSwipe(
  dx: number,
  velocityX: number,
  width: number,
  direction: TerminalTabSwipeDirection,
): boolean {
  const progress = Math.abs(dx) / Math.max(1, width);
  const velocityTowardTarget = direction === 1 ? -velocityX : velocityX;
  return progress >= SWIPE_COMMIT_FRACTION || velocityTowardTarget >= SWIPE_COMMIT_VELOCITY;
}
