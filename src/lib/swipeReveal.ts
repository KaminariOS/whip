export interface SwipeRevealPolicy {
  offset(dx: number, open: boolean): number;
  shouldClaim(dx: number, dy: number, open: boolean): boolean;
  shouldOpen(dx: number, vx: number, open: boolean): boolean;
}

export function createSwipeRevealPolicy(actionWidth: number): SwipeRevealPolicy {
  const offset = (dx: number, open: boolean): number => {
    const origin = open ? -actionWidth : 0;
    return Math.max(-actionWidth, Math.min(0, origin + dx));
  };

  return {
    offset,
    shouldClaim(dx, dy, open) {
      if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy) * 1.2) return false;
      return open ? dx > 0 : dx < 0;
    },
    shouldOpen(dx, vx, open) {
      if (Math.abs(vx) >= 0.35) return vx < 0;
      return offset(dx, open) < -actionWidth / 2;
    },
  };
}
