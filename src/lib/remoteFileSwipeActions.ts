import { createSwipeRevealPolicy } from './swipeReveal';

export const REMOTE_FILE_SWIPE_ACTION_WIDTH = 84;

const remoteFileSwipe = createSwipeRevealPolicy(REMOTE_FILE_SWIPE_ACTION_WIDTH);

export const remoteFileSwipeOffset = remoteFileSwipe.offset;
export const shouldClaimRemoteFileSwipe = remoteFileSwipe.shouldClaim;
export const shouldOpenRemoteFileSwipe = remoteFileSwipe.shouldOpen;
