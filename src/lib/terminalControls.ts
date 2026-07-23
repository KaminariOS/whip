export const defaultTerminalControlOrder = [
  'ctrl',
  'shift',
  'esc',
  'tab',
  'paste',
  'compose',
  'attach',
  'files',
  'up',
  'left',
  'right',
  'down',
  'enter',
  'slash',
  'hyphen',
  'pipe',
  'tilde',
  'end',
  'page-up',
  'page-down',
  'alt',
  'find',
  'shift-tab',
  'home',
] as const;

export type TerminalControlId = typeof defaultTerminalControlOrder[number];
export type TerminalControlUsage = Partial<Record<TerminalControlId, number>>;

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
