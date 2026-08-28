import type { PaneScrollInfo } from '../types';

export interface ScrollThumbGeometry {
  heightPercent: number;
  topPercent: number;
}

export interface ScrollDragGeometry {
  startOffset: number;
  dragDistance: number;
  maxOffset: number;
  trackHeight: number;
  thumbHeight: number;
  /** The offset change produced by a downward drag. */
  direction?: 1 | -1;
  /** Optional offset-unit increment, such as one terminal row. */
  step?: number;
}

export interface TerminalResumeViewport {
  offsetFromBottom: number;
  maxOffsetFromBottom: number;
}

const MIN_THUMB_PERCENT = 2;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function scrollThumbGeometry(
  offset: number,
  maxOffset: number,
  viewportSize: number,
): ScrollThumbGeometry | null {
  if (maxOffset <= 0 || viewportSize <= 0) return null;

  const boundedMaxOffset = Math.max(0, maxOffset);
  const boundedOffset = clamp(offset, 0, boundedMaxOffset);
  const totalSize = boundedMaxOffset + viewportSize;
  const heightPercent = clamp(
    (viewportSize / totalSize) * 100,
    MIN_THUMB_PERCENT,
    100,
  );
  const progressFromTop = boundedOffset / boundedMaxOffset;

  return {
    heightPercent,
    topPercent: progressFromTop * (100 - heightPercent),
  };
}

export function scrollOffsetFromDrag({
  startOffset,
  dragDistance,
  maxOffset,
  trackHeight,
  thumbHeight,
  direction = 1,
  step,
}: ScrollDragGeometry): number {
  const boundedMaxOffset = Math.max(0, maxOffset);
  if (boundedMaxOffset === 0) return 0;

  const thumbTravel = Math.max(0, trackHeight - thumbHeight);
  if (thumbTravel === 0) return clamp(startOffset, 0, boundedMaxOffset);

  const unrounded = startOffset
    + ((dragDistance / thumbTravel) * boundedMaxOffset * direction);
  const rounded = step && step > 0
    ? Math.round(unrounded / step) * step
    : unrounded;
  return clamp(rounded, 0, boundedMaxOffset);
}

export function terminalScrollThumb(scroll?: PaneScrollInfo): ScrollThumbGeometry | null {
  if (!scroll) return null;

  const maxOffset = scroll.max_offset_from_bottom;
  return scrollThumbGeometry(
    maxOffset - scroll.offset_from_bottom,
    maxOffset,
    scroll.viewport_rows,
  );
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

/**
 * Approximate the pre-background viewport after terminal output or reflow has
 * changed the scrollback extent. An offset of zero deliberately keeps following
 * the latest output.
 */
export function resumedTerminalScrollOffset(
  checkpoint: TerminalResumeViewport,
  currentMaxOffsetFromBottom: number,
): number {
  const maximum = Math.max(0, currentMaxOffsetFromBottom);
  if (checkpoint.offsetFromBottom <= 0) return 0;

  return clamp(
    checkpoint.offsetFromBottom
      + Math.max(0, maximum - checkpoint.maxOffsetFromBottom),
    0,
    maximum,
  );
}
