import { createSwipeRevealPolicy } from './swipeReveal';

export const REMOTE_FILE_SWIPE_ACTION_WIDTH = 84;

const remoteFileSwipe = createSwipeRevealPolicy(REMOTE_FILE_SWIPE_ACTION_WIDTH);

export const remoteFileSwipeOffset = (dx: number, open: boolean): number =>
  remoteFileSwipe.offset(dx, open);
export const shouldClaimRemoteFileSwipe = (dx: number, dy: number, open: boolean): boolean =>
  remoteFileSwipe.shouldClaim(dx, dy, open);
export const shouldOpenRemoteFileSwipe = (dx: number, vx: number, open: boolean): boolean =>
  remoteFileSwipe.shouldOpen(dx, vx, open);
