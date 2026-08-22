import {
  neighborTabIndex,
  shouldCommitTerminalTabSwipe,
  terminalTabSwipeDirection,
  terminalTabSwipeOffset,
} from '../src/lib/terminalTabSwipe';

describe('terminal tab swiping', () => {
  it('captures only deliberate, single-finger horizontal movement', () => {
    expect(terminalTabSwipeDirection(-24, 3, 1)).toBe(1);
    expect(terminalTabSwipeDirection(24, 3, 1)).toBe(-1);
    expect(terminalTabSwipeDirection(8, 0, 1)).toBeNull();
    expect(terminalTabSwipeDirection(24, 24, 1)).toBeNull();
    expect(terminalTabSwipeDirection(24, 3, 2)).toBeNull();
  });

  it('stops at the first and last tab', () => {
    expect(neighborTabIndex(1, 3, -1)).toBe(0);
    expect(neighborTabIndex(1, 3, 1)).toBe(2);
    expect(neighborTabIndex(0, 3, -1)).toBeNull();
    expect(neighborTabIndex(2, 3, 1)).toBeNull();
  });

  it('tracks the finger without moving beyond the neighboring page', () => {
    expect(terminalTabSwipeOffset(-120, 400, 1)).toBe(-120);
    expect(terminalTabSwipeOffset(-500, 400, 1)).toBe(-400);
    expect(terminalTabSwipeOffset(120, 400, -1)).toBe(120);
    expect(terminalTabSwipeOffset(-20, 400, -1)).toBe(0);
  });

  it('commits by distance or velocity toward the neighbor', () => {
    expect(shouldCommitTerminalTabSwipe(-101, 0, 400, 1)).toBe(true);
    expect(shouldCommitTerminalTabSwipe(-40, -0.5, 400, 1)).toBe(true);
    expect(shouldCommitTerminalTabSwipe(-40, 0.8, 400, 1)).toBe(false);
    expect(shouldCommitTerminalTabSwipe(101, 0, 400, -1)).toBe(true);
  });
});
