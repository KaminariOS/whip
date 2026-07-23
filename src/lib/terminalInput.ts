export type TerminalModifierState = 'off' | 'armed' | 'locked';

export function applyTerminalModifiers(
  data: string,
  ctrl: TerminalModifierState,
  alt: TerminalModifierState,
  shift: TerminalModifierState = 'off',
): string {
  let value = shift === 'off' ? data : applyShift(data);
  if (ctrl !== 'off' && value.length === 1) {
    value = String.fromCharCode(value.toUpperCase().charCodeAt(0) % 32);
  }
  if (alt !== 'off') value = `\u001b${value}`;
  return value;
}

const SHIFTED_CHARACTERS: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
};

function applyShift(data: string): string {
  if (data === '\t') return '\u001b[Z';
  if (data.length === 3 && data.startsWith('\u001b[') && 'ABCDHF'.includes(data[2])) {
    return `\u001b[1;2${data[2]}`;
  }
  if (data.length === 4 && data.startsWith('\u001b[') && '56'.includes(data[2]) && data[3] === '~') {
    return `\u001b[${data[2]};2~`;
  }
  if (data.length !== 1) return data;
  if (data >= 'a' && data <= 'z') return data.toUpperCase();
  return SHIFTED_CHARACTERS[data] || data;
}
