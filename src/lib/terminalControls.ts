export const defaultTerminalControlOrder = [
  'keyboard',
  'ctrl',
  'shift',
  'esc',
  'tab',
  'paste',
  'history',
  'compose',
  'chat',
  'attach',
  'files',
  'links',
  'up',
  'left',
  'right',
  'down',
  'enter',
  'slash',
  'pipe',
  'tilde',
  'end',
  'page-up',
  'page-down',
  'alt',
  'find',
  'home',
] as const;

export type TerminalControlId = typeof defaultTerminalControlOrder[number];
export type TerminalControlUsage = Partial<Record<TerminalControlId, number>>;

export const TERMINAL_ICON_CONTROL_CLASS =
  'h-11 w-11 items-center justify-center rounded-sm border border-border bg-card/70 p-0 active:bg-card/80';
export const TERMINAL_TEXT_CONTROL_CLASS =
  'h-11 min-w-11 items-center justify-center rounded-sm border border-border bg-card/70 px-2.5 py-0 active:bg-card/80';

const terminalControlIds = new Set<string>(defaultTerminalControlOrder);
const MAX_USAGE_COUNT = 1_000_000;

export function orderTerminalControls(usage: TerminalControlUsage): TerminalControlId[] {
  return [...defaultTerminalControlOrder].sort((left, right) => (
    (usage[right] || 0) - (usage[left] || 0)
      || defaultTerminalControlOrder.indexOf(left) - defaultTerminalControlOrder.indexOf(right)
  ));
}

export function incrementTerminalControlUsage(
  usage: TerminalControlUsage,
  control: TerminalControlId,
): TerminalControlUsage {
  return {
    ...usage,
    [control]: Math.min(MAX_USAGE_COUNT, (usage[control] || 0) + 1),
  };
}

export function parseTerminalControlUsage(value: unknown): TerminalControlUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const usage: TerminalControlUsage = {};
  for (const [control, count] of Object.entries(value)) {
    if (!terminalControlIds.has(control) || typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    usage[control as TerminalControlId] = Math.min(MAX_USAGE_COUNT, Math.round(count));
  }
  return usage;
}
