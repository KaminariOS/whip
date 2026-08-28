import {
  moveTerminalScroll,
  resumedTerminalScrollOffset,
  scrollOffsetFromDrag,
  scrollThumbGeometry,
  terminalScrollThumb,
} from '../src/lib/terminalScroll';

const scroll = { offset_from_bottom: 50, max_offset_from_bottom: 100, viewport_rows: 25 };

test('positions the terminal scroll thumb from top to bottom', () => {
  expect(terminalScrollThumb({ ...scroll, offset_from_bottom: 100 })).toEqual({
    heightPercent: 20,
    topPercent: 0,
  });
  expect(terminalScrollThumb({ ...scroll, offset_from_bottom: 50 })).toEqual({
    heightPercent: 20,
    topPercent: 40,
  });
  expect(terminalScrollThumb({ ...scroll, offset_from_bottom: 0 })).toEqual({
    heightPercent: 20,
    topPercent: 80,
  });
});

test('hides the terminal scroll thumb without scrollback', () => {
  expect(terminalScrollThumb({ offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 25 })).toBeNull();
  expect(terminalScrollThumb()).toBeNull();
});

test('updates and clamps the optimistic terminal scroll position', () => {
  expect(moveTerminalScroll(scroll, 'up', 75)?.offset_from_bottom).toBe(100);
  expect(moveTerminalScroll(scroll, 'down', 75)?.offset_from_bottom).toBe(0);
  expect(moveTerminalScroll(undefined, 'up', 5)).toBeUndefined();
});

test('positions a general scroll thumb at the top, middle, and bottom', () => {
  expect(scrollThumbGeometry(0, 100, 25)).toEqual({
    heightPercent: 20,
    topPercent: 0,
  });
  expect(scrollThumbGeometry(50, 100, 25)).toEqual({
    heightPercent: 20,
    topPercent: 40,
  });
  expect(scrollThumbGeometry(100, 100, 25)).toEqual({
    heightPercent: 20,
    topPercent: 80,
  });
});

test('uses the minimum thumb size for very large scrollback', () => {
  expect(scrollThumbGeometry(500_000_000, 1_000_000_000, 25)).toEqual({
    heightPercent: 2,
    topPercent: 49,
  });
});

test('maps upward and downward thumb dragging to offsets', () => {
  const geometry = {
    startOffset: 50,
    maxOffset: 100,
    trackHeight: 100,
    thumbHeight: 20,
  };
  expect(scrollOffsetFromDrag({ ...geometry, dragDistance: 16 })).toBe(70);
  expect(scrollOffsetFromDrag({ ...geometry, dragDistance: -16 })).toBe(30);
  expect(scrollOffsetFromDrag({ ...geometry, dragDistance: 16, direction: -1 })).toBe(30);
});

test('clamps thumb dragging at both ends', () => {
  const geometry = {
    startOffset: 50,
    maxOffset: 100,
    trackHeight: 100,
    thumbHeight: 20,
  };
  expect(scrollOffsetFromDrag({ ...geometry, dragDistance: -1_000 })).toBe(0);
  expect(scrollOffsetFromDrag({ ...geometry, dragDistance: 1_000 })).toBe(100);
});

test('handles zero scroll range and zero thumb travel', () => {
  expect(scrollThumbGeometry(0, 0, 25)).toBeNull();
  expect(scrollOffsetFromDrag({
    startOffset: 0,
    dragDistance: 50,
    maxOffset: 0,
    trackHeight: 100,
    thumbHeight: 20,
  })).toBe(0);
  expect(scrollOffsetFromDrag({
    startOffset: 40,
    dragDistance: 50,
    maxOffset: 100,
    trackHeight: 20,
    thumbHeight: 20,
  })).toBe(40);
});

test('preserves fractional pixel drag offsets', () => {
  expect(scrollOffsetFromDrag({
    startOffset: 100,
    dragDistance: 0.5,
    maxOffset: 1_000,
    trackHeight: 500,
    thumbHeight: 100,
  })).toBeCloseTo(101.25);
});

test('rounds row offsets consistently without adjacent drag oscillation', () => {
  const geometry = {
    startOffset: 50,
    maxOffset: 100,
    trackHeight: 100,
    thumbHeight: 20,
    step: 1,
  };
  expect(scrollOffsetFromDrag({ ...geometry, dragDistance: 0.1 })).toBe(50);
  expect(scrollOffsetFromDrag({ ...geometry, dragDistance: 0.3 })).toBe(50);
  expect(scrollOffsetFromDrag({ ...geometry, dragDistance: 0.9 })).toBe(51);
});

describe('resumedTerminalScrollOffset', () => {
  test('restores the previous offset when scrollback does not grow', () => {
    expect(resumedTerminalScrollOffset({
      offsetFromBottom: 200,
      maxOffsetFromBottom: 1_000,
    }, 1_000)).toBe(200);
  });

  test('accounts for output added while the app is backgrounded', () => {
    expect(resumedTerminalScrollOffset({
      offsetFromBottom: 200,
      maxOffsetFromBottom: 1_000,
    }, 1_050)).toBe(250);
  });

  test('keeps following latest output from an offset of zero', () => {
    expect(resumedTerminalScrollOffset({
      offsetFromBottom: 0,
      maxOffsetFromBottom: 1_000,
    }, 1_100)).toBe(0);
  });

  test('clamps restoration when scrollback shrinks', () => {
    expect(resumedTerminalScrollOffset({
      offsetFromBottom: 500,
      maxOffsetFromBottom: 1_000,
    }, 300)).toBe(300);
  });
});
