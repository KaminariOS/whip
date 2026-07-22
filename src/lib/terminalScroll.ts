import type { PaneScrollInfo } from '../types';

export interface TerminalScrollThumb {
  heightPercent: number;
  topPercent: number;
}

export function terminalScrollThumb(scroll?: PaneScrollInfo): TerminalScrollThumb | null {
  if (!scroll || scroll.max_offset_from_bottom <= 0 || scroll.viewport_rows <= 0) return null;

  const maxOffset = scroll.max_offset_from_bottom;
  const offset = Math.max(0, Math.min(maxOffset, scroll.offset_from_bottom));
  const totalRows = maxOffset + scroll.viewport_rows;
  const heightPercent = Math.max(2, Math.min(100, (scroll.viewport_rows / totalRows) * 100));
  const progressFromTop = (maxOffset - offset) / maxOffset;

  return {
    heightPercent,
    topPercent: progressFromTop * (100 - heightPercent),
  };
}

export function moveTerminalScroll(
  scroll: PaneScrollInfo | undefined,
  direction: 'up' | 'down',
  lines: number,
): PaneScrollInfo | undefined {
  if (!scroll) return scroll;
  const delta = Math.max(1, Math.round(lines));
  const nextOffset = scroll.offset_from_bottom + (direction === 'up' ? delta : -delta);
  return {
    ...scroll,
    offset_from_bottom: Math.max(0, Math.min(scroll.max_offset_from_bottom, nextOffset)),
  };
}
