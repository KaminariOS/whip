import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  addTerminalHistoryEntry,
  MAX_TERMINAL_HISTORY_ENTRIES,
  parseTerminalHistory,
  removeTerminalHistoryEntries,
} from '../src/lib/terminalHistory';

const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal input history', () => {
  it('keeps newest unique entries first and ignores blank text', () => {
    expect(addTerminalHistoryEntry(['first', 'second'], 'second'))
      .toEqual(['second', 'first']);

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
    expect(parseTerminalHistory(['first', null, '', 'second', 'first']))
      .toEqual(['first', 'second']);
    expect(removeTerminalHistoryEntries(['first', 'second', 'third'], ['first', 'third']))
      .toEqual(['second']);
  });

  it('records composer and paste input and pastes a selected entry without Enter', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');
    const renderer = readSource('src/components/TerminalRendererHost.tsx');

    expect(screen).toContain("if (control === 'history')");
    expect(screen).toContain('<History size={TERMINAL_ICON_SIZE}');
    expect(screen).toContain('onHistoryEntry(value);');
    expect(screen).toContain('onHistoryEntry(submitted);');
    expect(screen).toContain('const selectHistoryEntry = (entry: string) => {');
    expect(screen).toContain('renderer.current?.paste(entry);');
    expect(screen).toContain('onPaste={(_target, text) => onHistoryEntry(text)}');
    expect(screen).toContain('style={{ fontFamily: terminalFontFamily }}');
    expect(screen).toContain('font-mono text-[14px] leading-5');
    expect(renderer).toContain('reportPaste(entry.target, value);');
  });
});
