export const terminalVolumeKeyActions = [
  'none',
  'font-size',
  'scroll',
  'terminal-tab',
  'vertical-arrow',
  'horizontal-arrow',
] as const;

export type TerminalVolumeKeyAction = typeof terminalVolumeKeyActions[number];
export type TerminalVolumeKey = 'up' | 'down';

export type ResolvedTerminalVolumeKeyAction =
  | { type: 'font-size'; delta: -1 | 1 }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'terminal-tab'; direction: -1 | 1 }
  | { type: 'input'; data: string };

const terminalVolumeKeyActionSet = new Set<string>(terminalVolumeKeyActions);

export function parseTerminalVolumeKeyAction(
  value: unknown,
  fallback: TerminalVolumeKeyAction = 'none',
): TerminalVolumeKeyAction {
  return typeof value === 'string' && terminalVolumeKeyActionSet.has(value)
    ? value as TerminalVolumeKeyAction
    : fallback;
}

export function resolveTerminalVolumeKeyAction(
  action: TerminalVolumeKeyAction,
  key: TerminalVolumeKey,
): ResolvedTerminalVolumeKeyAction | null {
  if (action === 'none') return null;
  if (action === 'font-size') return { type: 'font-size', delta: key === 'up' ? 1 : -1 };
  if (action === 'scroll') return { type: 'scroll', direction: key };
  if (action === 'terminal-tab') return { type: 'terminal-tab', direction: key === 'up' ? -1 : 1 };
  if (action === 'vertical-arrow') return { type: 'input', data: key === 'up' ? '\u001b[A' : '\u001b[B' };
  return { type: 'input', data: key === 'up' ? '\u001b[D' : '\u001b[C' };
}
