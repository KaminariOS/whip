import { moveTerminalScroll, terminalScrollThumb } from '../src/lib/terminalScroll';

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
