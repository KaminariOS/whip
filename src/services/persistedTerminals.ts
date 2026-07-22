import AsyncStorage from '@react-native-async-storage/async-storage';

import type { HerdrSnapshot } from '../types';
import { openTerminalSession, type TerminalSessionsState } from '../terminalSessions';

const PREFIX = 'herdr.terminal.sessions.v1.';

interface PersistedTerminal {
  terminalId: string;
  paneId: string;
  title: string;
}

export async function loadPersistedTerminals(hostId: string, snapshot: HerdrSnapshot): Promise<TerminalSessionsState> {
  const value = await AsyncStorage.getItem(`${PREFIX}${hostId}`);
  if (!value) return { sessions: [], activeTerminalId: null };
  try {
    const parsed = JSON.parse(value) as { sessions?: PersistedTerminal[]; activeTerminalId?: string | null };
    const validIds = new Set(snapshot.panes.map(pane => pane.terminal_id));
    const sessions = (parsed.sessions || [])
      .filter(session => validIds.has(session.terminalId))
      .map(session => ({ ...session, status: 'connecting' as const, reconnectAttempt: 0 }));
    const activeTerminalId = sessions.some(session => session.terminalId === parsed.activeTerminalId)
      ? parsed.activeTerminalId || null
      : sessions[0]?.terminalId || null;
    const restored = { sessions, activeTerminalId };
    const focusedPane = snapshot.panes.find(pane => pane.pane_id === snapshot.focused_pane_id)
      ?? snapshot.panes.find(pane => pane.focused);
    return focusedPane ? openTerminalSession(restored, focusedPane) : restored;
  } catch {
    return { sessions: [], activeTerminalId: null };
  }
}

export async function savePersistedTerminals(hostId: string, state: TerminalSessionsState): Promise<void> {
  await AsyncStorage.setItem(`${PREFIX}${hostId}`, JSON.stringify({
    activeTerminalId: state.activeTerminalId,
    sessions: state.sessions.map(({ terminalId, paneId, title }) => ({ terminalId, paneId, title })),
  }));
}
