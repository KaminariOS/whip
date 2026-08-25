import { createSwipeRevealPolicy } from '../src/lib/swipeReveal';

describe('swipe reveal policy', () => {
  const swipe = createSwipeRevealPolicy(100);

  it('claims only a deliberate horizontal drag toward the available action', () => {
    expect(swipe.shouldClaim(-20, 2, false)).toBe(true);
    expect(swipe.shouldClaim(20, 2, false)).toBe(false);
    expect(swipe.shouldClaim(20, 2, true)).toBe(true);
    expect(swipe.shouldClaim(-20, 2, true)).toBe(false);
    expect(swipe.shouldClaim(-20, 19, false)).toBe(false);
    expect(swipe.shouldClaim(-8, 0, false)).toBe(false);
  });

  it('clamps movement between closed and fully revealed', () => {
    expect(swipe.offset(-40, false)).toBe(-40);
    expect(swipe.offset(-300, false)).toBe(-100);
    expect(swipe.offset(40, false)).toBe(0);
    expect(swipe.offset(40, true)).toBe(-60);
    expect(swipe.offset(300, true)).toBe(0);
  });

  it('settles using drag distance or velocity', () => {
    expect(swipe.shouldOpen(-60, 0, false)).toBe(true);
    expect(swipe.shouldOpen(-20, -0.5, false)).toBe(true);
    expect(swipe.shouldOpen(20, 0.5, true)).toBe(false);
    expect(swipe.shouldOpen(20, 0, true)).toBe(true);
    expect(swipe.shouldOpen(100, 0, true)).toBe(false);
  });
});
