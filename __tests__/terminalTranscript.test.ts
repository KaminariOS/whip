import { terminalTranscript } from '../src/lib/terminalTranscript';

test('creates a bounded ANSI terminal transcript', () => {
  const value = [
    '\u001b[31mold\u001b[0m',
    'middle',
    '\u001b[32mlatest\u001b[0m',
  ].join('\r\n');

  expect(terminalTranscript(value, 2)).toBe(
    'middle\r\n\u001b[32mlatest\u001b[0m',
  );
});

test('clamps transcript history to 5000 lines', () => {
  const lines = Array.from({ length: 5002 }, (_, index) => String(index));
  const transcript = terminalTranscript(lines.join('\n'), 10000).split('\r\n');
  expect(transcript).toHaveLength(5000);
  expect(transcript[0]).toBe('2');
});

test('removes OSC side effects while preserving ANSI styling', () => {
  expect(terminalTranscript(
    '\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b[31mred\u001b[0m',
    10,
  )).toBe('\u001b[31mred\u001b[0m');
});
