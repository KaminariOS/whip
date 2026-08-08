export const REMOTE_FILE_SWIPE_ACTION_WIDTH = 84;

export function shouldClaimRemoteFileSwipe(
  dx: number,
  dy: number,
  open: boolean,
): boolean {
  if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy) * 1.2) return false;
  return open ? dx > 0 : dx < 0;
}

export function remoteFileSwipeOffset(dx: number, open: boolean): number {
  const origin = open ? -REMOTE_FILE_SWIPE_ACTION_WIDTH : 0;
  return Math.max(
    -REMOTE_FILE_SWIPE_ACTION_WIDTH,
    Math.min(0, origin + dx),
  );
}

export function shouldOpenRemoteFileSwipe(
  dx: number,
  vx: number,
  open: boolean,
): boolean {
  if (Math.abs(vx) >= 0.35) return vx < 0;
  return remoteFileSwipeOffset(dx, open) < -REMOTE_FILE_SWIPE_ACTION_WIDTH / 2;
}
