import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppCoreProjection,
  NativeAppCore,
  RuntimeTerminalState,
} from 'react-native-whip-ssh';

import {
  emptyTerminalSessions,
  type TerminalSessionsState,
  type TerminalSessionStatus,
} from '../terminalSessions';
import type { PaneInfo } from '../types';
import {
  loadPersistedTerminals,
  PersistedTerminalsWriter,
  savePersistedTerminals,
} from '../services/persistedTerminals';
import { reportBackgroundFailure } from '../services/backgroundOperations';

export interface HostTerminalSessions {
  hostId: string;
  terminals: TerminalSessionsState;
}

export type TerminalSessionsByHost = ReadonlyMap<string, HostTerminalSessions>;

type CoreBinding = {
  core: NativeAppCore;
  commit: (view: AppCoreProjection) => void;
};

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

/** React cache, persistence adapter, and visual-only state for Rust terminal rails. */
export function useTerminalSessions() {
  const [state, setState] = useState<TerminalSessionsByHost>(() => new Map());
  const stateRef = useRef(state);
  const coreBindingRef = useRef<CoreBinding | null>(null);
  const composerDraftsRef = useRef(new Map<string, string>());
  const fontSizesRef = useRef(new Map<string, number>());
  const writerRef = useRef(new PersistedTerminalsWriter());
  stateRef.current = state;

  useEffect(() => {
    const retainedSessionIds = new Set(state.keys());
    for (const [sessionId, host] of state) {
      reportBackgroundFailure(
        writerRef.current.saveIfChanged(
          sessionId,
          host.hostId,
          host.terminals,
        ),
        'terminal-sessions-persist',
      );
    }
    writerRef.current.retainSessions(retainedSessionIds);
  }, [state]);

  const bindAppCore = useCallback(
    (core: NativeAppCore, commit: (view: AppCoreProjection) => void) => {
      coreBindingRef.current = { core, commit };
    },
    [],
  );

  const stateFromView = useCallback(
    (view: AppCoreProjection): TerminalSessionsByHost => new Map(
      view.sessions.map(session => [
        session.id,
        {
          hostId: session.hostId,
          terminals: {
            activeTerminalId: session.terminalRail.activeTerminalId ?? null,
            sessions: session.terminalRail.terminals.map(terminal => ({
              ...terminal,
              fontSize: fontSizesRef.current.get(
                terminalKey(session.id, terminal.terminalId),
              ),
            })),
          },
        },
      ]),
    ),
    [],
  );

  const projectAppCore = useCallback(
    (view: AppCoreProjection) => setState(stateFromView(view)),
    [stateFromView],
  );

  const requireCore = useCallback((): CoreBinding => {
    const binding = coreBindingRef.current;
    if (!binding) throw new Error('Rust AppCore is not attached to terminal state');
    return binding;
  }, []);

  const restore = useCallback(
    async (
      sessionId: string,
      hostId: string,
    ): Promise<TerminalSessionsState> => {
      const persisted = await loadPersistedTerminals(hostId);
      for (const [terminalId, fontSize] of persisted.fontSizes) {
          fontSizesRef.current.set(
            terminalKey(sessionId, terminalId),
            fontSize,
          );
      }
      const { core } = requireCore();
      const view = core.restoreTerminals(
        sessionId,
        persisted.terminalIds,
        persisted.activeTerminalId ?? undefined,
      );
      const terminals = stateFromView(view).get(sessionId)?.terminals
        ?? emptyTerminalSessions;
      writerRef.current.observe(sessionId, terminals);
      return terminals;
    },
    [requireCore, stateFromView],
  );

  const remove = useCallback((sessionId: string) => {
    const host = stateRef.current.get(sessionId);
    if (host) {
      reportBackgroundFailure(
        savePersistedTerminals(host.hostId, host.terminals),
        'terminal-session-remove-persist',
      );
    }
    for (const key of fontSizesRef.current.keys()) {
      if (key.startsWith(`${sessionId}:`)) fontSizesRef.current.delete(key);
    }
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

  const openPane = useCallback((sessionId: string, pane: PaneInfo) => {
    const { core, commit } = requireCore();
    commit(core.openPaneTerminal(sessionId, pane.pane_id));
  }, [requireCore]);

  const openSshShell = useCallback((sessionId: string, title = 'SSH shell') => {
    const { core, commit } = requireCore();
    commit(core.openSshShell(sessionId, title));
  }, [requireCore]);

  const close = useCallback((sessionId: string, terminalId: string) => {
    const { core, commit } = requireCore();
    commit(core.closeTerminal(sessionId, terminalId));
  }, [requireCore]);

  const updateLifecycle = useCallback((
    sessionId: string,
    terminalId: string,
    nativeState: RuntimeTerminalState,
    retrying: boolean,
    error?: string,
    reconnectAttempt = 0,
  ) => {
    const { core, commit } = requireCore();
    commit(core.updateTerminalLifecycle(
      sessionId,
      terminalId,
      nativeState,
      retrying,
      error,
      reconnectAttempt,
    ));
  }, [requireCore]);

  const updateStatus = useCallback((
    sessionId: string,
    terminalId: string,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt = 0,
  ) => {
    const nativeState: RuntimeTerminalState = status === 'connecting'
      ? 'opening'
      : status === 'connected'
        ? 'attached'
        : status === 'error'
          ? 'failed'
          : 'closed';
    updateLifecycle(
      sessionId,
      terminalId,
      nativeState,
      false,
      error,
      reconnectAttempt,
    );
  }, [updateLifecycle]);

  const updateFontSize = useCallback(
    (sessionId: string, terminalId: string, fontSize: number) => {
      fontSizesRef.current.set(terminalKey(sessionId, terminalId), fontSize);
      setState(current => {
        const host = current.get(sessionId);
        if (!host) return current;
        const terminals = {
          ...host.terminals,
          sessions: host.terminals.sessions.map(terminal =>
            terminal.terminalId === terminalId
              ? { ...terminal, fontSize }
              : terminal,
          ),
        };
        return updateHostTerminalSessions(
          current,
          sessionId,
          host.hostId,
          () => terminals,
        );
      });
    },
    [],
  );

  const getComposerDraft = useCallback(
    (sessionId: string, terminalId: string) =>
      composerDraftsRef.current.get(terminalKey(sessionId, terminalId)) || '',
    [],
  );

  const updateComposerDraft = useCallback(
    (sessionId: string, terminalId: string, value: string) => {
      const key = terminalKey(sessionId, terminalId);
      if (value) composerDraftsRef.current.set(key, value);
      else composerDraftsRef.current.delete(key);
    },
    [],
  );

  return useMemo(
    () => ({
      state,
      bindAppCore,
      projectAppCore,
      get,
      restore,
      remove,
      openPane,
      openSshShell,
      close,
      updateLifecycle,
      updateStatus,
      updateFontSize,
      getComposerDraft,
      updateComposerDraft,
    }),
    [
      bindAppCore,
      close,
      get,
      getComposerDraft,
      openPane,
      openSshShell,
      projectAppCore,
      remove,
      restore,
      state,
      updateComposerDraft,
      updateFontSize,
      updateLifecycle,
      updateStatus,
    ],
  );
}

function terminalKey(sessionId: string, terminalId: string): string {
  return `${sessionId}:${terminalId}`;
}
