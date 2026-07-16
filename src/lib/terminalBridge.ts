export interface TerminalFrame {
  type: 'terminal.frame';
  seq: number;
  encoding: 'ansi';
  width: number;
  height: number;
  full: boolean;
  bytes: string;
}

export interface TerminalClosed {
  type: 'terminal.closed';
  reason?: string;
}

export type TerminalBridgeEvent = TerminalFrame | TerminalClosed;

/**
 * Herdr's bridge is newline-delimited JSON. An SSH login shell may prepend a
 * banner, prompt, or echoed command, so non-protocol lines are deliberately
 * ignored instead of being rendered into xterm.
 */
export class TerminalBridgeDecoder {
  private pending = '';

  push(chunk: string): TerminalBridgeEvent[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() || '';
    return lines.flatMap(line => this.decodeLine(line));
  }

  private decodeLine(line: string): TerminalBridgeEvent[] {
    const objectStart = line.indexOf('{');
    if (objectStart < 0) return [];

    try {
      const value = JSON.parse(line.slice(objectStart).trim()) as Partial<TerminalBridgeEvent>;
      if (
        value.type === 'terminal.frame'
        && typeof value.bytes === 'string'
        && typeof value.seq === 'number'
      ) {
        return [value as TerminalFrame];
      }
      if (value.type === 'terminal.closed') return [value as TerminalClosed];
    } catch {
      // Login banners, prompts, and echoed commands are not bridge records.
    }
    return [];
  }
}

export function terminalInputCommand(text: string): string {
  return `${JSON.stringify({ type: 'terminal.input', text })}\n`;
}

export function terminalResizeCommand(
  columns: number,
  rows: number,
  cellWidthPx = 0,
  cellHeightPx = 0,
): string {
  return `${JSON.stringify({
    type: 'terminal.resize',
    cols: columns,
    rows,
    cell_width_px: cellWidthPx,
    cell_height_px: cellHeightPx,
  })}\n`;
}

export function terminalScrollCommand(direction: 'up' | 'down', lines: number): string {
  return `${JSON.stringify({ type: 'terminal.scroll', direction, lines, source: 'wheel' })}\n`;
}

export function terminalReleaseCommand(): string {
  return `${JSON.stringify({ type: 'terminal.release' })}\n`;
}
