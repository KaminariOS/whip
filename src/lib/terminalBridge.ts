export interface TerminalFrame {
  type: 'terminal.frame';
  seq: number;
  /** Herdr bridge frames are base64 ANSI bytes; SSH shell frames are decoded UTF-8 text. */
  encoding: 'ansi' | 'utf8';
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
