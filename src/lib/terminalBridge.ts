export interface TerminalFrame {
  type: 'terminal.frame';
  seq: number;
  encoding: 'ansi';
  width: number;
  height: number;
  full: boolean;
  bytes: string;
  /** Present when a large base64 frame is already split into bridge-safe chunks. */
  final?: boolean;
}

export interface TerminalClosed {
  type: 'terminal.closed';
  reason?: string;
}

export type TerminalBridgeEvent = TerminalFrame | TerminalClosed;
