import type {
  AppCoreProjection,
  HostRuntimeState,
} from 'react-native-whip-ssh';

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

export type LiveHostSyncStatus =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'stale'
  | 'error';

export interface LiveHostSelection {
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
}

export interface LiveHostSyncState {
  status: LiveHostSyncStatus;
  generation: number;
  connectionGeneration: number;
  revision: number;
  freshness: HostRuntimeState['freshness'];
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
}

export interface LiveHostSessionsState {
  sessions: LiveHostSession[];
  activeSessionId: string | null;
}

export const emptyLiveHostSessions: LiveHostSessionsState = {
  sessions: [],
  activeSessionId: null,
};

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

/**
 * Captures runtime-backed snapshots while the AppCore view and runtime registry
 * describe the same lifecycle instant. React may apply the render cache later.
 */
export function captureAppCoreHostSnapshots(
  core: AppCoreProjection,
  snapshotFromHostState: (
    sessionId: string,
    state: HostRuntimeState,
  ) => HerdrSnapshot,
): ReadonlyMap<string, HerdrSnapshot> {
  return new Map(core.sessions.flatMap(session => session.hostState
    ? [[
        session.id,
        snapshotFromHostState(session.id, session.hostState),
      ] as const]
    : []));
}

/**
 * Mechanical React render-cache projection. All session transitions and
 * selection repair have already happened in Rust AppCore.
 */
export function projectAppCoreSessions(
  core: AppCoreProjection,
  profiles: ReadonlyMap<string, HostProfile>,
  previous: LiveHostSessionsState,
  hostSnapshots: ReadonlyMap<string, HerdrSnapshot>,
): LiveHostSessionsState {
  return {
    sessions: core.sessions.map(nativeSession => {
      const previousSession = previous.sessions.find(
        session => session.id === nativeSession.id,
      );
      const host = profiles.get(nativeSession.hostId) ?? previousSession?.host;
      if (!host) {
        throw new Error(
          `Rust AppCore projected unknown host ${nativeSession.hostId}`,
        );
      }
      const nativeState = nativeSession.hostState;
      const snapshot = nativeState
        ? hostSnapshots.get(nativeSession.id)
        : previousSession?.snapshot ?? createEmptyHerdrSnapshot();
      if (!snapshot) {
        throw new Error(
          `Rust AppCore host state was not captured for ${nativeSession.id}`,
        );
      }
      return {
        id: nativeSession.id,
        hostId: nativeSession.hostId,
        host,
        status: nativeSession.connectionStatus,
        connectionError: nativeSession.connectionError ?? null,
        reconnectAttempt: nativeSession.reconnectAttempt,
        snapshot,
        sync: nativeState
          ? syncProjection(nativeState, previousSession?.sync)
          : previousSession?.sync ?? emptySyncState(),
        selection: {
          workspaceId: nativeSession.selection.workspaceId ?? null,
          tabId: nativeSession.selection.tabId ?? null,
          paneId: nativeSession.selection.paneId ?? null,
        },
      };
    }),
    activeSessionId: core.activeSessionId ?? null,
  };
}

function emptySyncState(): LiveHostSyncState {
  return {
    status: 'idle',
    generation: 0,
    connectionGeneration: 0,
    revision: 0,
    freshness: 'loading',
    error: null,
    lastSyncedAt: null,
  };
}

function syncProjection(
  state: HostRuntimeState,
  previous?: LiveHostSyncState,
): LiveHostSyncState {
  const status: LiveHostSyncStatus = state.syncStatus === 'error'
    ? 'error'
    : state.syncStatus === 'syncing'
      ? 'syncing'
      : state.freshness === 'fresh'
        ? 'synced'
        : state.freshness === 'stale'
          ? 'stale'
          : 'idle';
  return {
    status,
    generation: state.syncGeneration,
    connectionGeneration: state.connectionGeneration,
    revision: state.revision,
    freshness: state.freshness,
    error: state.error ?? null,
    lastSyncedAt: state.lastSyncedAtMs
      ? new Date(state.lastSyncedAtMs).toISOString()
      : previous?.lastSyncedAt ?? null,
  };
}

/** A connecting host has no usable control channel for snapshot refreshes yet. */
export function canRefreshLiveHostSession(
  session: LiveHostSession | null | undefined,
): session is LiveHostSession {
  return Boolean(session && session.status !== 'connecting');
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

/**
 * Temporary command-result projection used by imperative focus flows. The
 * durable UI selection itself is owned and validated by Rust AppCore.
 */
export function preferredWorkspacePane(
  snapshot: HerdrSnapshot,
  workspaceId: string,
): PaneInfo | undefined {
  const workspace = snapshot.workspaces.find(
    item => item.workspace_id === workspaceId,
  );
  if (!workspace) return undefined;
  const tab = preferredTab(snapshot, workspace);
  return tab ? preferredPane(snapshot, tab) : undefined;
}

function preferredTab(
  snapshot: HerdrSnapshot,
  workspace: WorkspaceInfo,
): TabInfo | undefined {
  const tabs = snapshot.tabs.filter(
    item => item.workspace_id === workspace.workspace_id,
  );
  return tabs.find(item => item.tab_id === workspace.active_tab_id)
    ?? tabs.find(item => item.focused)
    ?? tabs[0];
}

function preferredPane(
  snapshot: HerdrSnapshot,
  tab: TabInfo,
): PaneInfo | undefined {
  const panes = snapshot.panes.filter(item => item.tab_id === tab.tab_id);
  return panes.find(item => item.focused) ?? panes[0];
}
