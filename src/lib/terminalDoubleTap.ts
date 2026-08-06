export const terminalDoubleTapActions = [
  'none',
  'paste',
  'tab',
  'escape',
] as const;

export type TerminalDoubleTapAction = typeof terminalDoubleTapActions[number];

const terminalDoubleTapActionSet = new Set<string>(terminalDoubleTapActions);

export function parseTerminalDoubleTapAction(
  value: unknown,
  fallback: TerminalDoubleTapAction = 'tab',
): TerminalDoubleTapAction {
  return typeof value === 'string' && terminalDoubleTapActionSet.has(value)
    ? value as TerminalDoubleTapAction
    : fallback;
}
