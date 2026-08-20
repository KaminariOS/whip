export interface TerminalFrame {
  type: 'terminal.frame';
  seq: number;
  /** Herdr frames are raw ANSI bytes; compatibility frames may still be base64 strings. */
  encoding: 'ansi' | 'utf8';
  width: number;
  height: number;
  full: boolean;
  bytes: string | ArrayBuffer;
  /** Present when a large base64 frame is already split into bridge-safe chunks. */
  final?: boolean;
}

export interface TerminalClosed {
  type: 'terminal.closed';
  reason?: string;
}

export type TerminalBridgeEvent = TerminalFrame | TerminalClosed;
