export interface TerminalSession {
  terminalId: string;
  paneId: string;
  title: string;
  /** Visual-only preference retained by the React persistence adapter. */
  fontSize?: number;
  kind?: 'herdr' | 'ssh';
  status: TerminalSessionStatus;
  error?: string;
  reconnectAttempt: number;
}

export type TerminalSessionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface TerminalSessionsState {
  sessions: TerminalSession[];
  activeTerminalId: string | null;
}

export const emptyTerminalSessions: TerminalSessionsState = {
  sessions: [],
  activeTerminalId: null,
};

export const SSH_SHELL_TERMINAL_ID = '__whip_ssh_shell__';

export function isSshShellTerminalId(terminalId: string): boolean {
  return terminalId === SSH_SHELL_TERMINAL_ID;
}
