import { createSwipeRevealPolicy } from './swipeReveal';

export const HOST_SWIPE_ACTION_WIDTH = 152;

const hostSwipe = createSwipeRevealPolicy(HOST_SWIPE_ACTION_WIDTH);

export const hostSwipeOffset = (dx: number, open: boolean): number => hostSwipe.offset(dx, open);
export const shouldClaimHostSwipe = (dx: number, dy: number, open: boolean): boolean =>
  hostSwipe.shouldClaim(dx, dy, open);
export const shouldOpenHostSwipe = (dx: number, vx: number, open: boolean): boolean =>
  hostSwipe.shouldOpen(dx, vx, open);
