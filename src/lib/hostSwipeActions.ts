import { createSwipeRevealPolicy } from './swipeReveal';

export const HOST_SWIPE_ACTION_WIDTH = 152;

const hostSwipe = createSwipeRevealPolicy(HOST_SWIPE_ACTION_WIDTH);

export const hostSwipeOffset = hostSwipe.offset;
export const shouldClaimHostSwipe = hostSwipe.shouldClaim;
export const shouldOpenHostSwipe = hostSwipe.shouldOpen;
