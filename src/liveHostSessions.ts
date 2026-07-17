import type { TerminalSessionsState } from './terminalSessions';
import type { HerdrSnapshot, HostProfile, PaneInfo, TabInfo, WorkspaceInfo } from './types';

export type LiveHostConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export type LiveHostSyncStatus = 'idle' | 'syncing' | 'synced' | 'stale' | 'error';

export interface LiveHostSelection {
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
}

export interface LiveHostSyncState {
  status: LiveHostSyncStatus;
  /** Monotonically increasing token used to reject stale async responses. */
  generation: number;
  error: string | null;
  lastSyncedAt: string | null;
}

export interface LiveHostSession {
  id: string;
  hostId: string;
  host: HostProfile;
  status: LiveHostConnectionStatus;
  connectionError: string | null;
  reconnectAttempt: number;
  snapshot: HerdrSnapshot;
  sync: LiveHostSyncState;
  selection: LiveHostSelection;
  terminals: TerminalSessionsState;
}

export interface LiveHostSessionsState {
  sessions: LiveHostSession[];
  activeSessionId: string | null;
}

export interface LiveHostConnectionUpdate {
  status: LiveHostConnectionStatus;
  error?: string | null;
  reconnectAttempt?: number;
}

export interface LiveHostSyncRequest {
  state: LiveHostSessionsState;
  generation: number;
}

export const emptyLiveHostSessions: LiveHostSessionsState = {
  sessions: [],
  activeSessionId: null,
};

export function createEmptyHerdrSnapshot(): HerdrSnapshot {
  return {
    server: { running: false },
    agents: [],
    workspaces: [],
    tabs: [],
    panes: [],
  };
}

export function createLiveHostSession(
  host: HostProfile,
  sessionId = host.id,
): LiveHostSession {
  return {
    id: sessionId,
    hostId: host.id,
    host,
    status: 'connecting',
    connectionError: null,
    reconnectAttempt: 0,
    snapshot: createEmptyHerdrSnapshot(),
    sync: {
      status: 'idle',
      generation: 0,
      error: null,
      lastSyncedAt: null,
    },
    selection: {
      workspaceId: null,
      tabId: null,
      paneId: null,
    },
    terminals: {
      sessions: [],
      activeTerminalId: null,
    },
  };
}

/** Add a live host to the outer session rail and make it active. */
export function openLiveHostSession(
  state: LiveHostSessionsState,
  host: HostProfile,
  sessionId = host.id,
): LiveHostSessionsState {
  const existing = state.sessions.find(session => session.id === sessionId);
  if (existing) {
    return {
      sessions: state.sessions.map(session => session.id === sessionId
        ? {
          ...session,
          hostId: host.id,
          host,
          status: 'connecting',
          connectionError: null,
          reconnectAttempt: 0,
        }
        : session),
      activeSessionId: sessionId,
    };
  }

  return {
    sessions: [...state.sessions, createLiveHostSession(host, sessionId)],
    activeSessionId: sessionId,
  };
}

export function selectLiveHostSession(
  state: LiveHostSessionsState,
  sessionId: string,
): LiveHostSessionsState {
  if (state.activeSessionId === sessionId) return state;
  return state.sessions.some(session => session.id === sessionId)
    ? { ...state, activeSessionId: sessionId }
    : state;
}

/** Select the newest live session for a saved host. */
export function selectLiveHost(
  state: LiveHostSessionsState,
  hostId: string,
): LiveHostSessionsState {
  const session = [...state.sessions].reverse().find(item => item.hostId === hostId);
  return session ? selectLiveHostSession(state, session.id) : state;
}

/**
 * Remove one host session. Matching Voltius, closing the active session selects
 * the last surviving rail item instead of disconnecting any other host.
 */
export function closeLiveHostSession(
  state: LiveHostSessionsState,
  sessionId: string,
): LiveHostSessionsState {
  if (!state.sessions.some(session => session.id === sessionId)) return state;
  const sessions = state.sessions.filter(session => session.id !== sessionId);
  return {
    sessions,
    activeSessionId: state.activeSessionId === sessionId
      ? sessions[sessions.length - 1]?.id ?? null
      : state.activeSessionId,
  };
}

export function updateLiveHostConnection(
  state: LiveHostSessionsState,
  sessionId: string,
  update: LiveHostConnectionUpdate,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const connectionError = update.error !== undefined
      ? update.error
      : update.status === 'connected' || update.status === 'connecting'
        ? null
        : session.connectionError;
    const reconnectAttempt = update.reconnectAttempt
      ?? (update.status === 'connected' ? 0 : session.reconnectAttempt);
    const losesFreshness = update.status === 'reconnecting'
      || update.status === 'disconnected'
      || update.status === 'error';

    return {
      ...session,
      status: update.status,
      connectionError,
      reconnectAttempt,
      sync: losesFreshness && session.sync.status === 'synced'
        ? { ...session.sync, status: 'stale' }
        : session.sync,
    };
  });
}

/** Start a snapshot request and return the generation the async result must carry. */
export function beginLiveHostSync(
  state: LiveHostSessionsState,
  sessionId: string,
): LiveHostSyncRequest {
  const session = findLiveHostSession(state, sessionId);
  if (!session) return { state, generation: -1 };
  const generation = session.sync.generation + 1;
  return {
    generation,
    state: updateSession(state, sessionId, current => ({
      ...current,
      sync: {
        ...current.sync,
        status: 'syncing',
        generation,
        error: null,
      },
    })),
  };
}

/** Apply a snapshot only when it belongs to the newest request for this host. */
export function applyLiveHostSnapshot(
  state: LiveHostSessionsState,
  sessionId: string,
  generation: number,
  snapshot: HerdrSnapshot,
  syncedAt: string | null = null,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    if (session.sync.generation !== generation) return session;
    return {
      ...session,
      snapshot,
      selection: serverFocusSelection(snapshot),
      sync: {
        status: 'synced',
        generation,
        error: null,
        lastSyncedAt: syncedAt,
      },
    };
  });
}

/** Apply a focus event immediately while the authoritative snapshot refresh runs. */
export function applyLiveHostFocus(
  state: LiveHostSessionsState,
  sessionId: string,
  target: { workspaceId?: string; tabId?: string; paneId?: string },
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const pane = target.paneId
      ? session.snapshot.panes.find(item => item.pane_id === target.paneId)
      : undefined;
    const tabId = pane?.tab_id ?? target.tabId;
    const tab = tabId
      ? session.snapshot.tabs.find(item => item.tab_id === tabId)
      : undefined;
    const workspaceId = pane?.workspace_id ?? tab?.workspace_id ?? target.workspaceId;
    const workspace = workspaceId
      ? session.snapshot.workspaces.find(item => item.workspace_id === workspaceId)
      : undefined;
    if (!workspace) return session;

    const activeTabId = tab?.tab_id ?? workspace.active_tab_id;
    const focusedPane = pane
      ?? session.snapshot.panes.find(item => item.tab_id === activeTabId && item.focused)
      ?? session.snapshot.panes.find(item => item.tab_id === activeTabId);
    const snapshot: HerdrSnapshot = {
      ...session.snapshot,
      workspaces: session.snapshot.workspaces.map(item => ({
        ...item,
        focused: item.workspace_id === workspace.workspace_id,
        active_tab_id: item.workspace_id === workspace.workspace_id ? activeTabId : item.active_tab_id,
      })),
      tabs: session.snapshot.tabs.map(item => ({
        ...item,
        focused: item.tab_id === activeTabId,
      })),
      panes: session.snapshot.panes.map(item => ({
        ...item,
        focused: focusedPane ? item.pane_id === focusedPane.pane_id : item.focused,
      })),
    };
    return {
      ...session,
      snapshot,
      selection: serverFocusSelection(snapshot),
    };
  });
}

export function failLiveHostSync(
  state: LiveHostSessionsState,
  sessionId: string,
  generation: number,
  error: string,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    if (session.sync.generation !== generation) return session;
    return {
      ...session,
      sync: {
        ...session.sync,
        status: 'error',
        error,
      },
    };
  });
}

export function selectLiveHostWorkspace(
  state: LiveHostSessionsState,
  sessionId: string,
  workspaceId: string,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const workspace = session.snapshot.workspaces.find(item => item.workspace_id === workspaceId);
    if (!workspace) return session;
    const tab = preferredTab(session.snapshot, workspace);
    const pane = tab ? preferredPane(session.snapshot, tab) : undefined;
    return {
      ...session,
      selection: {
        workspaceId,
        tabId: tab?.tab_id ?? null,
        paneId: pane?.pane_id ?? null,
      },
    };
  });
}

export function selectLiveHostTab(
  state: LiveHostSessionsState,
  sessionId: string,
  tabId: string,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const tab = session.snapshot.tabs.find(item => item.tab_id === tabId);
    if (!tab) return session;
    const pane = preferredPane(session.snapshot, tab);
    return {
      ...session,
      selection: {
        workspaceId: tab.workspace_id,
        tabId,
        paneId: pane?.pane_id ?? null,
      },
    };
  });
}

export function selectLiveHostPane(
  state: LiveHostSessionsState,
  sessionId: string,
  paneId: string,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const pane = session.snapshot.panes.find(item => item.pane_id === paneId);
    if (!pane) return session;
    return {
      ...session,
      selection: {
        workspaceId: pane.workspace_id,
        tabId: pane.tab_id,
        paneId,
      },
    };
  });
}

export function replaceLiveHostTerminals(
  state: LiveHostSessionsState,
  sessionId: string,
  terminals: TerminalSessionsState,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => ({ ...session, terminals }));
}

export function updateLiveHostTerminals(
  state: LiveHostSessionsState,
  sessionId: string,
  updater: (terminals: TerminalSessionsState) => TerminalSessionsState,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const terminals = updater(session.terminals);
    return terminals === session.terminals ? session : { ...session, terminals };
  });
}

export function findLiveHostSession(
  state: LiveHostSessionsState,
  sessionId: string,
): LiveHostSession | undefined {
  return state.sessions.find(session => session.id === sessionId);
}

export function getActiveLiveHostSession(
  state: LiveHostSessionsState,
): LiveHostSession | null {
  if (!state.activeSessionId) return null;
  return findLiveHostSession(state, state.activeSessionId) ?? null;
}

function updateSession(
  state: LiveHostSessionsState,
  sessionId: string,
  updater: (session: LiveHostSession) => LiveHostSession,
): LiveHostSessionsState {
  const index = state.sessions.findIndex(session => session.id === sessionId);
  if (index < 0) return state;
  const current = state.sessions[index];
  const next = updater(current);
  if (next === current) return state;
  const sessions = [...state.sessions];
  sessions[index] = next;
  return { ...state, sessions };
}

function serverFocusSelection(snapshot: HerdrSnapshot): LiveHostSelection {
  const workspace = snapshot.workspaces.find(item => item.focused)
    ?? snapshot.workspaces[0];
  if (!workspace) return { workspaceId: null, tabId: null, paneId: null };

  const tab = preferredTab(snapshot, workspace);
  if (!tab) return { workspaceId: workspace.workspace_id, tabId: null, paneId: null };

  const pane = preferredPane(snapshot, tab);
  return {
    workspaceId: workspace.workspace_id,
    tabId: tab.tab_id,
    paneId: pane?.pane_id ?? null,
  };
}

function preferredTab(snapshot: HerdrSnapshot, workspace: WorkspaceInfo): TabInfo | undefined {
  const tabs = snapshot.tabs.filter(item => item.workspace_id === workspace.workspace_id);
  return tabs.find(item => item.tab_id === workspace.active_tab_id)
    ?? tabs.find(item => item.focused)
    ?? tabs[0];
}

function preferredPane(snapshot: HerdrSnapshot, tab: TabInfo): PaneInfo | undefined {
  const panes = snapshot.panes.filter(item => item.tab_id === tab.tab_id);
  return panes.find(item => item.focused) ?? panes[0];
}
