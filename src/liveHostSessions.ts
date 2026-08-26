import type { TerminalSessionsState } from './terminalSessions';
import type { HostRuntimeState } from 'react-native-whip-ssh';
import {
  initialLatencyWarningState,
  nextLatencyWarningState,
  type LatencyWarningState,
} from './lib/latencyWarning';
import type {
  HerdrSnapshot,
  HostProfile,
  PaneInfo,
  TabInfo,
  WorkspaceInfo,
} from './types';

export type LiveHostConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'ready'
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
  /** Rust-owned snapshot synchronization generation. */
  generation: number;
  /** Rust-owned connection generation and domain-state revision. */
  connectionGeneration: number;
  revision: number;
  freshness: HostRuntimeState['freshness'];
  error: string | null;
  lastSyncedAt: string | null;
  /** Latest successful Android-to-host network round trip. */
  latencyMs: number | null;
  latencyWarning: LatencyWarningState;
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

export const emptyLiveHostSessions: LiveHostSessionsState = {
  sessions: [],
  activeSessionId: null,
};

/** A connecting host has no usable control channel for snapshot refreshes yet. */
export function canRefreshLiveHostSession(
  session: LiveHostSession | null | undefined,
): session is LiveHostSession {
  return Boolean(session && session.status !== 'connecting');
}

export function createEmptyHerdrSnapshot(): HerdrSnapshot {
  return {
    server: { running: false },
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
    agents: [],
    workspaces: [],
    tabs: [],
    panes: [],
    layouts: [],
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
      connectionGeneration: 0,
      revision: 0,
      freshness: 'loading',
      error: null,
      lastSyncedAt: null,
      latencyMs: null,
      latencyWarning: initialLatencyWarningState,
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
  activate = true,
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
      activeSessionId: activate ? sessionId : state.activeSessionId,
    };
  }

  return {
    sessions: [...state.sessions, createLiveHostSession(host, sessionId)],
    activeSessionId: activate ? sessionId : state.activeSessionId,
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
 * Remove one host session. Matching the session rail, closing the active
 * session selects the last surviving rail item instead of disconnecting any
 * other host.
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
      : update.status === 'ready'
        || update.status === 'connected'
        || update.status === 'connecting'
        ? null
        : session.connectionError;
    const reconnectAttempt = update.reconnectAttempt
      ?? (update.status === 'ready' || update.status === 'connected'
        ? 0
        : session.reconnectAttempt);
    const losesTransportLatency = update.status === 'reconnecting'
      || update.status === 'disconnected'
      || update.status === 'error';
    const sync = losesTransportLatency
      ? {
          ...session.sync,
          latencyMs: null,
          latencyWarning: initialLatencyWarningState,
        }
      : session.sync;

    if (
      session.status === update.status
      && session.connectionError === connectionError
      && session.reconnectAttempt === reconnectAttempt
      && session.sync === sync
    ) {
      return session;
    }

    return {
      ...session,
      status: update.status,
      connectionError,
      reconnectAttempt,
      sync,
    };
  });
}

/** Apply a lightweight RTT sample without changing snapshot synchronization state. */
export function applyLiveHostLatency(
  state: LiveHostSessionsState,
  sessionId: string,
  latencyMs: number,
): LiveHostSessionsState {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return state;
  return updateSession(state, sessionId, session => {
    if (session.status !== 'ready') return session;
    const latencyWarning = nextLatencyWarningState(session.sync.latencyWarning, latencyMs);
    if (session.sync.latencyMs === latencyMs && latencyWarning === session.sync.latencyWarning) {
      return session;
    }
    return {
      ...session,
      sync: {
        ...session.sync,
        latencyMs,
        latencyWarning,
      },
    };
  });
}

/**
 * Discard a latency sample after its transport probe fails. Keeping the last
 * successful value would make an unreachable host look both current and fast.
 */
export function invalidateLiveHostLatency(
  state: LiveHostSessionsState,
  sessionId: string,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    if (
      session.sync.latencyMs === null
      && session.sync.latencyWarning === initialLatencyWarningState
    ) {
      return session;
    }
    return {
      ...session,
      sync: {
        ...session.sync,
        latencyMs: null,
        latencyWarning: initialLatencyWarningState,
      },
    };
  });
}

/**
 * Replace the React render cache with a newer Rust-owned HostState projection.
 * No Herdr event or snapshot reconciliation occurs in TypeScript.
 */
export function applyNativeHostState(
  state: LiveHostSessionsState,
  sessionId: string,
  nativeState: HostRuntimeState,
  snapshot: HerdrSnapshot,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    if (nativeState.revision <= session.sync.revision) return session;
    const selection = validUiSelection(snapshot, session.selection)
      ? session.selection
      : serverFocusSelection(snapshot);
    const status: LiveHostSyncStatus = nativeState.syncStatus === 'error'
      ? 'error'
      : nativeState.syncStatus === 'syncing'
        ? 'syncing'
        : nativeState.freshness === 'fresh'
          ? 'synced'
          : nativeState.freshness === 'stale'
            ? 'stale'
            : 'idle';
    return {
      ...session,
      snapshot,
      selection,
      sync: {
        ...session.sync,
        status,
        generation: nativeState.syncGeneration,
        connectionGeneration: nativeState.connectionGeneration,
        revision: nativeState.revision,
        freshness: nativeState.freshness,
        error: nativeState.error ?? null,
        lastSyncedAt: nativeState.lastSyncedAtMs
          ? new Date(nativeState.lastSyncedAtMs).toISOString()
          : session.sync.lastSyncedAt,
      },
    };
  });
}

/** Mobile-only selection; this never changes Herdr's authoritative focus. */
export function selectLiveHostWorkspaceView(
  state: LiveHostSessionsState,
  sessionId: string,
  workspaceId: string,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const pane = preferredWorkspacePane(session.snapshot, workspaceId);
    const workspace = session.snapshot.workspaces.find(item => item.workspace_id === workspaceId);
    if (!workspace) return session;
    const selection: LiveHostSelection = {
      workspaceId,
      tabId: pane?.tab_id ?? workspace.active_tab_id ?? null,
      paneId: pane?.pane_id ?? null,
    };
    return session.selection.workspaceId === selection.workspaceId
      && session.selection.tabId === selection.tabId
      && session.selection.paneId === selection.paneId
      ? session
      : { ...session, selection };
  });
}

/** Resolve the terminal pane Herdr considers active for a workspace. */
export function preferredWorkspacePane(
  snapshot: HerdrSnapshot,
  workspaceId: string,
): PaneInfo | undefined {
  const workspace = snapshot.workspaces.find(item => item.workspace_id === workspaceId);
  if (!workspace) return undefined;
  const tab = preferredTab(snapshot, workspace);
  return tab ? preferredPane(snapshot, tab) : undefined;
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
  const workspace = snapshot.workspaces.find(item => item.workspace_id === snapshot.focused_workspace_id)
    ?? snapshot.workspaces.find(item => item.focused)
    ?? snapshot.workspaces[0];
  if (!workspace) return { workspaceId: null, tabId: null, paneId: null };

  const tab = snapshot.tabs.find(item => (
    item.tab_id === snapshot.focused_tab_id && item.workspace_id === workspace.workspace_id
  )) ?? preferredTab(snapshot, workspace);
  if (!tab) return { workspaceId: workspace.workspace_id, tabId: null, paneId: null };

  const pane = snapshot.panes.find(item => (
    item.pane_id === snapshot.focused_pane_id && item.tab_id === tab.tab_id
  )) ?? preferredPane(snapshot, tab);
  return {
    workspaceId: workspace.workspace_id,
    tabId: tab.tab_id,
    paneId: pane?.pane_id ?? null,
  };
}

function validUiSelection(snapshot: HerdrSnapshot, selection: LiveHostSelection): boolean {
  if (!selection.workspaceId) return snapshot.workspaces.length === 0;
  const workspace = snapshot.workspaces.find(item => item.workspace_id === selection.workspaceId);
  if (!workspace) return false;
  if (!selection.tabId) return !snapshot.tabs.some(item => item.workspace_id === workspace.workspace_id);
  const tab = snapshot.tabs.find(item => (
    item.tab_id === selection.tabId && item.workspace_id === workspace.workspace_id
  ));
  if (!tab) return false;
  if (!selection.paneId) return !snapshot.panes.some(item => item.tab_id === tab.tab_id);
  return snapshot.panes.some(item => (
    item.pane_id === selection.paneId && item.tab_id === tab.tab_id
  ));
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
