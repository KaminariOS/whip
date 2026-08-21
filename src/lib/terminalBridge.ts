export interface TerminalFrame {
  type: 'terminal.frame';
  seq: number;
  /** Herdr frames are raw ANSI byte views; compatibility frames may still use strings or buffers. */
  encoding: 'ansi' | 'utf8';
  width: number;
  height: number;
  full: boolean;
  bytes: string | ArrayBuffer | ArrayBufferView;
  /** Present when a large base64 frame is already split into bridge-safe chunks. */
  final?: boolean;
}

export interface TerminalClosed {
  type: 'terminal.closed';
  reason?: string;
}

export type TerminalBridgeEvent = TerminalFrame | TerminalClosed;
