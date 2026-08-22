import { applyTerminalModifiers } from '../src/lib/terminalInput';

test('encodes Ctrl+A for the program running inside the attached pane', () => {
  expect(applyTerminalModifiers('a', 'armed', 'off')).toBe('\u0001');
  expect(applyTerminalModifiers('A', 'locked', 'off')).toBe('\u0001');
});

test('encodes Ctrl+C as the interrupt byte instead of a printable c', () => {
  expect(applyTerminalModifiers('c', 'armed', 'off')).toBe('\u0003');
});

test('preserves direct control bytes from the terminal key rail', () => {
  expect(applyTerminalModifiers('\u0003', 'armed', 'off')).toBe('\u0003');
});

test('applies Alt after Ctrl and leaves multi-character input intact', () => {
  expect(applyTerminalModifiers('a', 'armed', 'armed')).toBe('\u001b\u0001');
  expect(applyTerminalModifiers('paste', 'locked', 'off')).toBe('paste');
});

test('applies Shift to characters and terminal navigation keys', () => {
  expect(applyTerminalModifiers('a', 'off', 'off', 'armed')).toBe('A');
  expect(applyTerminalModifiers('/', 'off', 'off', 'locked')).toBe('?');
  expect(applyTerminalModifiers('\t', 'off', 'off', 'armed')).toBe('\u001b[Z');
  expect(applyTerminalModifiers('\u001b[A', 'off', 'off', 'armed')).toBe('\u001b[1;2A');
});

test('encodes text and modified keys when Kitty report-all mode is active', () => {
  expect(applyTerminalModifiers('a', 'off', 'off', 'off', true)).toBe('\u001b[97;1:1;97u');
  expect(applyTerminalModifiers('a', 'off', 'off', 'armed', true)).toBe('\u001b[97:65;2:1;65u');
  expect(applyTerminalModifiers('c', 'armed', 'off', 'off', true)).toBe('\u001b[99;5:1u');
  expect(applyTerminalModifiers('\r', 'off', 'off', 'armed', true)).toBe('\u001b[13;2:1u');
  expect(applyTerminalModifiers('\u001b[A', 'off', 'off', 'armed', true)).toBe('\u001b[1;2:1A');
});

test('preserves already encoded terminal protocols in Kitty report-all mode', () => {
  expect(applyTerminalModifiers('\u001b[<64;4;8M', 'off', 'off', 'off', true)).toBe('\u001b[<64;4;8M');
  expect(applyTerminalModifiers('\u001b[200~pasted\u001b[201~', 'off', 'off', 'off', true)).toBe(
    '\u001b[200~pasted\u001b[201~',
  );
});
