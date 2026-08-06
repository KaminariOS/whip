export const MAX_TERMINAL_HISTORY_ENTRIES = 50;

export function addTerminalHistoryEntry(
  entries: readonly string[],
  value: string,
): string[] {
  if (!value.trim()) return [...entries];
  return [
    value,
    ...entries.filter(entry => entry !== value),
  ].slice(0, MAX_TERMINAL_HISTORY_ENTRIES);
}

export function parseTerminalHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || entries.includes(item)) continue;
    entries.push(item);
    if (entries.length === MAX_TERMINAL_HISTORY_ENTRIES) break;
  }
  return entries;
}

export function removeTerminalHistoryEntries(
  entries: readonly string[],
  selected: readonly string[],
): string[] {
  const removed = new Set(selected);
  return entries.filter(entry => !removed.has(entry));
}
