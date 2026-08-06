import {
  terminalRendererEvictionKeys,
  touchTerminalRendererEntry,
} from '../src/lib/terminalRendererLru';

describe('terminal renderer LRU', () => {
  test('evicts the least recently used entries first', () => {
    expect(terminalRendererEvictionKeys(
      ['oldest', 'older', 'middle', 'recent', 'newer', 'active'],
      4,
      new Set(['active']),
    )).toEqual(['oldest', 'older']);
  });

  test('protects both terminals involved in a swipe from eviction', () => {
    expect(terminalRendererEvictionKeys(
      ['oldest', 'older', 'recent', 'origin', 'preview'],
      4,
      new Set(['origin', 'preview']),
    )).toEqual(['oldest']);
  });

  test('touching an entry moves it to the most-recent position', () => {
    const entries = new Map([
      ['first', 1],
      ['second', 2],
      ['third', 3],
    ]);

    expect(touchTerminalRendererEntry(entries, 'first')).toBe(1);
    expect([...entries.keys()]).toEqual(['second', 'third', 'first']);
  });

  test('does not impose an upper capacity bound', () => {
    const keys = Array.from({ length: 60 }, (_, index) => `terminal-${index}`);
    expect(terminalRendererEvictionKeys(keys, 99, new Set())).toEqual([]);
  });
});
