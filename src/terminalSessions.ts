import type { PaneInfo } from './types';

export interface TerminalSession {
  terminalId: string;
  paneId: string;
  title: string;
  status: TerminalSessionStatus;
  error?: string;
  reconnectAttempt: number;
}

export type TerminalSessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface TerminalSessionsState {
  sessions: TerminalSession[];
  activeTerminalId: string | null;
}

export const emptyTerminalSessions: TerminalSessionsState = {
  sessions: [],
  activeTerminalId: null,
};

function titleForPane(pane: PaneInfo): string {
  return pane.label || pane.display_agent || pane.agent || pane.pane_id;
}

export function openTerminalSession(
  state: TerminalSessionsState,
  pane: PaneInfo,
): TerminalSessionsState {
  const existing = state.sessions.find(session => session.terminalId === pane.terminal_id);
  if (existing) {
    return {
      sessions: state.sessions.map(session =>
        session.terminalId === pane.terminal_id
          ? { ...session, paneId: pane.pane_id, title: titleForPane(pane) }
          : session,
      ),
      activeTerminalId: existing.terminalId,
    };
  }

  const session: TerminalSession = {
    terminalId: pane.terminal_id,
    paneId: pane.pane_id,
    title: titleForPane(pane),
    status: 'connecting',
    reconnectAttempt: 0,
  };
  return {
    sessions: [...state.sessions, session],
    activeTerminalId: session.terminalId,
  };
}

export function updateTerminalSession(
  state: TerminalSessionsState,
  terminalId: string,
  update: Partial<Pick<TerminalSession, 'status' | 'error' | 'reconnectAttempt' | 'title' | 'paneId'>>,
): TerminalSessionsState {
  if (!state.sessions.some(session => session.terminalId === terminalId)) return state;
  return {
    ...state,
    sessions: state.sessions.map(session => (
      session.terminalId === terminalId ? { ...session, ...update } : session
    )),
  };
}

export function selectTerminalSession(
  state: TerminalSessionsState,
  terminalId: string,
): TerminalSessionsState {
  return state.sessions.some(session => session.terminalId === terminalId)
    ? { ...state, activeTerminalId: terminalId }
    : state;
}

export function closeTerminalSession(
  state: TerminalSessionsState,
  terminalId: string,
): TerminalSessionsState {
  const index = state.sessions.findIndex(session => session.terminalId === terminalId);
  if (index < 0) {
    return state;
  }

  const sessions = state.sessions.filter(session => session.terminalId !== terminalId);
  if (state.activeTerminalId !== terminalId) {
    return { sessions, activeTerminalId: state.activeTerminalId };
  }

  const fallback = sessions[Math.min(index, sessions.length - 1)];
  return {
    sessions,
    activeTerminalId: fallback?.terminalId ?? null,
  };
}
