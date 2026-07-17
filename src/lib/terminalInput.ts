export type TerminalModifierState = 'off' | 'armed' | 'locked';

export function applyTerminalModifiers(
  data: string,
  ctrl: TerminalModifierState,
  alt: TerminalModifierState,
): string {
  let value = data;
  if (ctrl !== 'off' && value.length === 1) {
    value = String.fromCharCode(value.toUpperCase().charCodeAt(0) % 32);
  }
  if (alt !== 'off') value = `\u001b${value}`;
  return value;
}
