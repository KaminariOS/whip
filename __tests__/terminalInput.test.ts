import { applyTerminalModifiers } from '../src/lib/terminalInput';

test('encodes Ctrl+A for the program running inside the attached pane', () => {
  expect(applyTerminalModifiers('a', 'armed', 'off')).toBe('\u0001');
  expect(applyTerminalModifiers('A', 'locked', 'off')).toBe('\u0001');
});

test('preserves direct control bytes from the terminal key rail', () => {
  expect(applyTerminalModifiers('\u0003', 'armed', 'off')).toBe('\u0003');
});

test('applies Alt after Ctrl and leaves multi-character input intact', () => {
  expect(applyTerminalModifiers('a', 'armed', 'armed')).toBe('\u001b\u0001');
  expect(applyTerminalModifiers('paste', 'locked', 'off')).toBe('paste');
});
