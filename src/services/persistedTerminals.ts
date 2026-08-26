import AsyncStorage from '@react-native-async-storage/async-storage';

import type { HerdrSnapshot } from '../types';
import { openTerminalSession, type TerminalSessionsState } from '../terminalSessions';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

const PREFIX = 'herdr.terminal.sessions.v1.';

interface PersistedTerminal {
  terminalId: string;
  paneId: string;
  title: string;
  fontSize?: number;
}

interface ObservedPersistedTerminals {
  state: TerminalSessionsState;
  value: string;
}

function persistedFontSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(8, Math.min(24, Math.round(value)))
    : undefined;
}

export async function loadPersistedTerminals(hostId: string, snapshot: HerdrSnapshot): Promise<TerminalSessionsState> {
  const storageKey = `${PREFIX}${hostId}`;
  let value: string | null;
  try {
    value = await AsyncStorage.getItem(storageKey);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'persisted-terminal-sessions',
      storageKey,
      phase: 'session-restore',
      operation: 'getItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  if (!value) return { sessions: [], activeTerminalId: null };
  try {
    const parsedValue = JSON.parse(value) as unknown;
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      throw new TypeError('Stored terminal sessions must be an object');
    }
    const parsed = parsedValue as { sessions?: PersistedTerminal[]; activeTerminalId?: string | null };
    const validIds = new Set(snapshot.panes.map(pane => pane.terminal_id));
    const sessions = (parsed.sessions || [])
      .filter(session => validIds.has(session.terminalId))
      .map(session => ({
        ...session,
        fontSize: persistedFontSize(session.fontSize),
        status: 'connecting' as const,
        reconnectAttempt: 0,
      }));
    const activeTerminalId = sessions.some(session => session.terminalId === parsed.activeTerminalId)
      ? parsed.activeTerminalId || null
      : sessions[0]?.terminalId || null;
    const restored = { sessions, activeTerminalId };
    const focusedPane = snapshot.panes.find(pane => pane.pane_id === snapshot.focused_pane_id)
      ?? snapshot.panes.find(pane => pane.focused);
    return focusedPane ? openTerminalSession(restored, focusedPane) : restored;
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'persisted-terminal-sessions',
      storageKey,
      phase: 'session-restore',
      operation: 'parse',
      fallbackUsed: 'empty-terminal-sessions',
      ...storageParseErrorDetails(error),
    });
    return { sessions: [], activeTerminalId: null };
  }
}

function persistedTerminalsValue(state: TerminalSessionsState): string {
  const sessions = state.sessions.filter(session => session.kind !== 'ssh');
  const activeTerminalId = sessions.some(session => session.terminalId === state.activeTerminalId)
    ? state.activeTerminalId
    : sessions[0]?.terminalId ?? null;
  return JSON.stringify({
    activeTerminalId,
    sessions: sessions.map(({ terminalId, paneId, title, fontSize }) => ({
      terminalId,
      paneId,
      title,
      fontSize: persistedFontSize(fontSize),
    })),
  });
}

async function savePersistedTerminalsValue(hostId: string, value: string): Promise<void> {
  const storageKey = `${PREFIX}${hostId}`;
  try {
    await AsyncStorage.setItem(storageKey, value);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-write-failed', {
      store: 'persisted-terminal-sessions',
      storageKey,
      phase: 'persistence',
      operation: 'setItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

export async function savePersistedTerminals(hostId: string, state: TerminalSessionsState): Promise<void> {
  await savePersistedTerminalsValue(hostId, persistedTerminalsValue(state));
}

/**
 * Tracks the normalized persisted value for each live session so callers may
 * observe a broad session collection without rewriting terminal metadata when
 * only latency, snapshots, agent state, or terminal connection status changed.
 */
export class PersistedTerminalsWriter {
  private readonly observedBySessionId = new Map<string, ObservedPersistedTerminals>();

  async saveIfChanged(
    sessionId: string,
    hostId: string,
    state: TerminalSessionsState,
  ): Promise<boolean> {
    const previous = this.observedBySessionId.get(sessionId);
    if (previous?.state === state) return false;

    const value = persistedTerminalsValue(state);
    const observed = { state, value };
    this.observedBySessionId.set(sessionId, observed);
    if (previous?.value === value) return false;

    try {
      await savePersistedTerminalsValue(hostId, value);
      return true;
    } catch (error) {
      if (this.observedBySessionId.get(sessionId) === observed) {
        this.observedBySessionId.delete(sessionId);
      }
      throw error;
    }
  }

  retainSessions(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.observedBySessionId.keys()) {
      if (!sessionIds.has(sessionId)) this.observedBySessionId.delete(sessionId);
    }
  }
}
