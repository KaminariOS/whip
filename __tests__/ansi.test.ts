import { dominantAnsiBackground, parseAnsi, resolvedStyle } from '../src/lib/ansi';

test('parses truecolor foreground and background styles', () => {
  const segments = parseAnsi('\u001b[38;2;255;121;198m\u001b[48;2;40;42;54mBuild\u001b[0m plain');
  expect(segments).toEqual([
    { text: 'Build', style: { foreground: '#ff79c6', background: '#282a36' } },
    { text: ' plain', style: {} },
  ]);
  expect(dominantAnsiBackground(segments, '#000000')).toBe('#282a36');
});

test('supports indexed colors, modifiers, reverse, and CRLF', () => {
  const segments = parseAnsi('\u001b[1;38;5;10;48;5;17;7mHi\r\n\u001b[0m');
  expect(segments[0].text).toBe('Hi\n');
  expect(segments[0].style.bold).toBe(true);
  expect(resolvedStyle(segments[0].style)).toMatchObject({
    foreground: '#00005f',
    background: '#9fe044',
  });
});

test('strips non-SGR terminal control sequences', () => {
  expect(parseAnsi('a\u001b[2Jb\u001b[Hc')).toEqual([{ text: 'abc', style: {} }]);
});
