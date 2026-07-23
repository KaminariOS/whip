export const HOST_SWIPE_ACTION_WIDTH = 152;

export function shouldClaimHostSwipe(
  dx: number,
  dy: number,
  open: boolean,
): boolean {
  if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy) * 1.2) return false;
  return open ? dx > 0 : dx < 0;
}

export function hostSwipeOffset(dx: number, open: boolean): number {
  const origin = open ? -HOST_SWIPE_ACTION_WIDTH : 0;
  return Math.max(
    -HOST_SWIPE_ACTION_WIDTH,
    Math.min(0, origin + dx),
  );
}

export function shouldOpenHostSwipe(
  dx: number,
  vx: number,
  open: boolean,
): boolean {
  if (Math.abs(vx) >= 0.35) return vx < 0;
  return hostSwipeOffset(dx, open) < -HOST_SWIPE_ACTION_WIDTH / 2;
}
