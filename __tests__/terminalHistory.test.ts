import {
  addTerminalHistoryEntry,
  MAX_TERMINAL_HISTORY_ENTRIES,
  parseTerminalHistory,
  removeTerminalHistoryEntries,
} from '../src/lib/terminalHistory';

describe('terminal input history', () => {
  it('keeps newest unique entries first and ignores blank text', () => {
    expect(addTerminalHistoryEntry(['first', 'second'], 'second')).toEqual([
      'second',
      'first',
    ]);

    const entries = ['first'];
    expect(addTerminalHistoryEntry(entries, '   ')).toEqual(entries);
  });

  it('caps history without modifying the submitted text', () => {
    const entries = Array.from(
      { length: MAX_TERMINAL_HISTORY_ENTRIES },
      (_, index) => `entry ${index}`,
    );

    const next = addTerminalHistoryEntry(entries, '  newest command  ');

    expect(next).toHaveLength(MAX_TERMINAL_HISTORY_ENTRIES);
    expect(next[0]).toBe('  newest command  ');
    expect(next).not.toContain(`entry ${MAX_TERMINAL_HISTORY_ENTRIES - 1}`);
  });

  it('parses only valid unique entries and removes a selection in bulk', () => {
    expect(
      parseTerminalHistory(['first', null, '', 'second', 'first']),
    ).toEqual(['first', 'second']);
    expect(
      removeTerminalHistoryEntries(
        ['first', 'second', 'third'],
        ['first', 'third'],
      ),
    ).toEqual(['second']);
  });
});
