import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  closeTerminalSession,
  emptyTerminalSessions,
  openSshShellSession,
  openTerminalSession,
  reconcileTerminalSessions,
  updateTerminalSession,
  type TerminalSessionsState,
  type TerminalSessionStatus,
} from '../terminalSessions';
import type { HerdrSnapshot, PaneInfo } from '../types';
import {
  loadPersistedTerminals,
  PersistedTerminalsWriter,
  savePersistedTerminals,
} from '../services/persistedTerminals';

export interface HostTerminalSessions {
  hostId: string;
  terminals: TerminalSessionsState;
}

export type TerminalSessionsByHost = ReadonlyMap<string, HostTerminalSessions>;

export function updateHostTerminalSessions(
  state: TerminalSessionsByHost,
  sessionId: string,
  hostId: string,
  updater: (current: TerminalSessionsState) => TerminalSessionsState,
): TerminalSessionsByHost {
  const current = state.get(sessionId);
  const terminals = updater(current?.terminals ?? emptyTerminalSessions);
  if (current?.hostId === hostId && terminals === current.terminals)
    return state;
  const next = new Map(state);
  next.set(sessionId, { hostId, terminals });
  return next;
}

/**
 * Owns terminal metadata, restoration, and persistence. Host runtime state is
 * deliberately an input to specific operations rather than part of this state.
 */
export function useTerminalSessions() {
  const [state, setState] = useState<TerminalSessionsByHost>(() => new Map());
  const stateRef = useRef(state);
  const composerDraftsRef = useRef(new Map<string, string>());
  const writerRef = useRef(new PersistedTerminalsWriter());
  stateRef.current = state;

  useEffect(() => {
    const retainedSessionIds = new Set(state.keys());
    for (const [sessionId, host] of state) {
      writerRef.current
        .saveIfChanged(sessionId, host.hostId, host.terminals)
        .catch(() => undefined);
    }
    writerRef.current.retainSessions(retainedSessionIds);
  }, [state]);

  const replace = useCallback(
    (sessionId: string, hostId: string, terminals: TerminalSessionsState) => {
      setState(current =>
        updateHostTerminalSessions(current, sessionId, hostId, () => terminals),
      );
    },
    [],
  );

  const update = useCallback(
    (
      sessionId: string,
      updater: (current: TerminalSessionsState) => TerminalSessionsState,
    ) => {
      setState(current => {
        const host = current.get(sessionId);
        return host
          ? updateHostTerminalSessions(current, sessionId, host.hostId, updater)
          : current;
      });
    },
    [],
  );

  const restore = useCallback(
    async (
      sessionId: string,
      hostId: string,
      snapshot: HerdrSnapshot,
    ): Promise<TerminalSessionsState> => {
      const terminals = await loadPersistedTerminals(hostId, snapshot);
      writerRef.current.observe(sessionId, terminals);
      replace(sessionId, hostId, terminals);
      return terminals;
    },
    [replace],
  );

  const remove = useCallback((sessionId: string) => {
    const host = stateRef.current.get(sessionId);
    if (host)
      savePersistedTerminals(host.hostId, host.terminals).catch(
        () => undefined,
      );
    setState(current => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const get = useCallback(
    (sessionId: string): TerminalSessionsState =>
      stateRef.current.get(sessionId)?.terminals ?? emptyTerminalSessions,
    [],
  );

  const reconcile = useCallback(
    (sessionId: string, panes: PaneInfo[]) => {
      update(sessionId, terminals =>
        reconcileTerminalSessions(terminals, panes),
      );
    },
    [update],
  );

  const openPane = useCallback(
    (sessionId: string, pane: PaneInfo) => {
      update(sessionId, terminals => openTerminalSession(terminals, pane));
    },
    [update],
  );

  const openSshShell = useCallback(
    (sessionId: string, title?: string) => {
      update(sessionId, terminals => openSshShellSession(terminals, title));
    },
    [update],
  );

  const close = useCallback(
    (sessionId: string, terminalId: string) => {
      update(sessionId, terminals =>
        closeTerminalSession(terminals, terminalId),
      );
    },
    [update],
  );

  const updateStatus = useCallback(
    (
      sessionId: string,
      terminalId: string,
      status: TerminalSessionStatus,
      error?: string,
      reconnectAttempt?: number,
    ) => {
      update(sessionId, terminals =>
        updateTerminalSession(terminals, terminalId, {
          status,
          error,
          reconnectAttempt:
            reconnectAttempt ?? (status === 'connected' ? 0 : undefined),
        }),
      );
    },
    [update],
  );

  const updateFontSize = useCallback(
    (sessionId: string, terminalId: string, fontSize: number) => {
      update(sessionId, terminals =>
        updateTerminalSession(terminals, terminalId, { fontSize }),
      );
    },
    [update],
  );

  const getComposerDraft = useCallback(
    (sessionId: string, terminalId: string) =>
      composerDraftsRef.current.get(`${sessionId}:${terminalId}`) || '',
    [],
  );

  const updateComposerDraft = useCallback(
    (sessionId: string, terminalId: string, value: string) => {
      const key = `${sessionId}:${terminalId}`;
      if (value) composerDraftsRef.current.set(key, value);
      else composerDraftsRef.current.delete(key);
    },
    [],
  );

  return useMemo(
    () => ({
      state,
      get,
      replace,
      restore,
      remove,
      reconcile,
      openPane,
      openSshShell,
      close,
      updateStatus,
      updateFontSize,
      getComposerDraft,
      updateComposerDraft,
    }),
    [
      close,
      get,
      getComposerDraft,
      openPane,
      openSshShell,
      reconcile,
      remove,
      replace,
      restore,
      state,
      updateComposerDraft,
      updateFontSize,
      updateStatus,
    ],
  );
}
