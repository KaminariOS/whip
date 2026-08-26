import type { TerminalSessionsState } from './terminalSessions';
import { agentFromStatusEvent, type AgentStatusUpdate } from './lib/agentStatusEvents';
import {
  initialLatencyWarningState,
  nextLatencyWarningState,
  type LatencyWarningState,
} from './lib/latencyWarning';
import type {
  AgentStatus,
  HerdrSnapshot,
  HostProfile,
  PaneInfo,
  PaneLayoutSnapshot,
  TabInfo,
  WorkspaceInfo,
} from './types';

export interface CreatedWorkspaceResources {
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
}

export interface CreatedTabResources {
  tab: TabInfo;
  root_pane: PaneInfo;
}

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
  /** Monotonically increasing token used to reject stale async responses. */
  generation: number;
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

export interface LiveHostSyncRequest {
  state: LiveHostSessionsState;
  generation: number;
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
    const losesFreshness = update.status === 'reconnecting'
      || update.status === 'disconnected'
      || update.status === 'error';
    const sync = losesFreshness
      ? {
          ...session.sync,
          status: session.sync.status === 'synced' ? 'stale' as const : session.sync.status,
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
    const syncStatus = session.sync.status === 'synced' ? 'stale' : session.sync.status;
    if (
      session.sync.latencyMs === null
      && session.sync.latencyWarning === initialLatencyWarningState
      && syncStatus === session.sync.status
    ) {
      return session;
    }
    return {
      ...session,
      sync: {
        ...session.sync,
        status: syncStatus,
        latencyMs: null,
        latencyWarning: initialLatencyWarningState,
      },
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
  latencyMs: number | null = null,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    if (session.sync.generation !== generation) return session;
    const readyLatencyMs = session.status === 'ready' ? latencyMs : null;
    return {
      ...session,
      snapshot,
      selection: serverFocusSelection(snapshot),
      sync: {
        status: 'synced',
        generation,
        error: null,
        lastSyncedAt: syncedAt,
        latencyMs: readyLatencyMs,
        latencyWarning: nextLatencyWarningState(session.sync.latencyWarning, readyLatencyMs),
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
      focused_workspace_id: workspace.workspace_id,
      focused_tab_id: activeTabId ?? null,
      focused_pane_id: focusedPane?.pane_id ?? null,
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

function upsertById<T>(items: T[], item: T, id: (value: T) => string): T[] {
  return items.some(current => id(current) === id(item))
    ? items.map(current => id(current) === id(item) ? item : current)
    : [...items, item];
}

/** Project workspace.create's authoritative topology before event reconciliation. */
export function applyLiveHostWorkspaceCreation(
  state: LiveHostSessionsState,
  sessionId: string,
  created: CreatedWorkspaceResources,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const workspace = { ...created.workspace, focused: true };
    const tab = { ...created.tab, focused: true };
    const rootPane = { ...created.root_pane, focused: true };
    const snapshot: HerdrSnapshot = {
      ...session.snapshot,
      focused_workspace_id: workspace.workspace_id,
      focused_tab_id: tab.tab_id,
      focused_pane_id: rootPane.pane_id,
      workspaces: upsertById(
        session.snapshot.workspaces.map(item => ({ ...item, focused: false })),
        workspace,
        item => item.workspace_id,
      ),
      tabs: upsertById(
        session.snapshot.tabs.map(item => ({ ...item, focused: false })),
        tab,
        item => item.tab_id,
      ),
      panes: upsertById(
        session.snapshot.panes.map(item => ({ ...item, focused: false })),
        rootPane,
        item => item.pane_id,
      ),
    };
    return { ...session, snapshot, selection: serverFocusSelection(snapshot) };
  });
}

/** Project tab.create's authoritative objects before event reconciliation. */
export function applyLiveHostTabCreation(
  state: LiveHostSessionsState,
  sessionId: string,
  created: CreatedTabResources,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const tab = { ...created.tab, focused: true };
    const rootPane = { ...created.root_pane, focused: true };
    const snapshot: HerdrSnapshot = {
      ...session.snapshot,
      focused_workspace_id: tab.workspace_id,
      focused_tab_id: tab.tab_id,
      focused_pane_id: rootPane.pane_id,
      workspaces: session.snapshot.workspaces.map(item => ({
        ...item,
        focused: item.workspace_id === tab.workspace_id,
        active_tab_id: item.workspace_id === tab.workspace_id ? tab.tab_id : item.active_tab_id,
        tab_count: item.workspace_id === tab.workspace_id
          ? Math.max(item.tab_count, session.snapshot.tabs.filter(existing => existing.workspace_id === tab.workspace_id && existing.tab_id !== tab.tab_id).length + 1)
          : item.tab_count,
      })),
      tabs: upsertById(
        session.snapshot.tabs.map(item => ({ ...item, focused: false })),
        tab,
        item => item.tab_id,
      ),
      panes: upsertById(
        session.snapshot.panes.map(item => ({ ...item, focused: false })),
        rootPane,
        item => item.pane_id,
      ),
    };
    return { ...session, snapshot, selection: serverFocusSelection(snapshot) };
  });
}

/** Apply the public status event immediately; the following snapshot remains authoritative. */
export function applyLiveHostAgentStatus(
  state: LiveHostSessionsState,
  sessionId: string,
  paneId: string,
  data: AgentStatusUpdate,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const paneIndex = session.snapshot.panes.findIndex(pane => pane.pane_id === paneId);
    if (paneIndex < 0) return session;

    const currentPane = session.snapshot.panes[paneIndex];
    const updatedPane = paneFromAgentStatusEvent(
      currentPane,
      data.agent_status,
      data,
    );
    const panes = [...session.snapshot.panes];
    panes[paneIndex] = updatedPane;
    const agents = session.snapshot.agents.map(agent => {
      if (agent.pane_id !== paneId) return agent;
      return agentFromStatusEvent(agent, data);
    });
    const tabStatuses: AgentStatus[] = [];
    const workspaceStatuses: AgentStatus[] = [];
    for (const pane of panes) {
      if (pane.tab_id === updatedPane.tab_id)
        tabStatuses.push(pane.agent_status);
      if (pane.workspace_id === updatedPane.workspace_id)
        workspaceStatuses.push(pane.agent_status);
    }
    const tabStatus = aggregateAgentStatus(tabStatuses);
    const workspaceStatus = aggregateAgentStatus(workspaceStatuses);
    const tabs = session.snapshot.tabs.map(tab =>
      tab.tab_id === updatedPane.tab_id
        ? { ...tab, agent_status: tabStatus }
        : tab,
    );
    const workspaces = session.snapshot.workspaces.map(workspace =>
      workspace.workspace_id === updatedPane.workspace_id
        ? { ...workspace, agent_status: workspaceStatus }
        : workspace,
    );

    return {
      ...session,
      snapshot: { ...session.snapshot, agents, panes, tabs, workspaces },
    };
  });
}

/** Apply complete pane metadata carried by pane.updated without waiting for a snapshot. */
export function applyLiveHostPaneUpdate(
  state: LiveHostSessionsState,
  sessionId: string,
  pane: PaneInfo,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    if (!session.snapshot.panes.some(item => item.pane_id === pane.pane_id)) return session;
    return {
      ...session,
      snapshot: {
        ...session.snapshot,
        panes: session.snapshot.panes.map(item => item.pane_id === pane.pane_id ? pane : item),
      },
    };
  });
}

/** Apply layout.updated immediately so layout state follows the native session. */
export function applyLiveHostLayoutUpdate(
  state: LiveHostSessionsState,
  sessionId: string,
  layout: PaneLayoutSnapshot,
): LiveHostSessionsState {
  return updateSession(state, sessionId, session => {
    const layouts = session.snapshot.layouts.some(item => item.tab_id === layout.tab_id)
      ? session.snapshot.layouts.map(item => item.tab_id === layout.tab_id ? layout : item)
      : [...session.snapshot.layouts, layout];
    return { ...session, snapshot: { ...session.snapshot, layouts } };
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

const AGENT_STATUS_PRIORITY: Record<AgentStatus, number> = {
  blocked: 5,
  done: 4,
  working: 3,
  idle: 2,
  unknown: 1,
};

export function aggregateAgentStatus(statuses: AgentStatus[]): AgentStatus {
  return statuses.reduce<AgentStatus>((aggregate, status) => (
    AGENT_STATUS_PRIORITY[status] > AGENT_STATUS_PRIORITY[aggregate] ? status : aggregate
  ), 'unknown');
}

function paneFromAgentStatusEvent(
  pane: PaneInfo,
  agentStatus: AgentStatus,
  data: AgentStatusUpdate,
): PaneInfo {
  const next = { ...pane, agent_status: agentStatus };
  for (const field of ['agent', 'title', 'display_agent'] as const) {
    const value = data[field];
    if (value !== undefined) next[field] = value;
  }
  if (data.state_labels) next.state_labels = data.state_labels;
  return next;
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
