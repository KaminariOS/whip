import type { HostRuntimeState } from 'react-native-whip-ssh';
import {
  applyNativeHostState,
  canRefreshLiveHostSession,
  closeLiveHostSession,
  emptyLiveHostSessions,
  findLiveHostSession,
  getActiveLiveHostSession,
  openLiveHostSession,
  preferredWorkspacePane,
  selectLiveHost,
  selectLiveHostSession,
  selectLiveHostWorkspaceView,
  updateLiveHostConnection,
} from '../src/liveHostSessions';
import type {
  HerdrSnapshot,
  HostProfile,
  PaneInfo,
  TabInfo,
  WorkspaceInfo,
} from '../src/types';

function host(id: string): HostProfile {
  return {
    id,
    name: id.toUpperCase(),
    host: `${id}.example.test`,
    port: '22',
    username: 'herdr',
    authMode: 'key',
    herdrCommand: 'herdr',
    sessionName: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function workspace(id: string, activeTabId: string, focused = false): WorkspaceInfo {
  return {
    workspace_id: id,
    number: 1,
    label: id,
    focused,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: activeTabId,
    agent_status: 'idle',
  };
}

function tab(id: string, workspaceId: string, focused = false): TabInfo {
  return {
    tab_id: id,
    workspace_id: workspaceId,
    number: 1,
    label: id,
    focused,
    pane_count: 1,
    agent_status: 'idle',
  };
}

function pane(id: string, workspaceId: string, tabId: string, focused = false): PaneInfo {
  return {
    pane_id: id,
    terminal_id: `terminal-${id}`,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused,
    label: id,
    agent_status: 'idle',
    revision: 1,
  };
}

function snapshot(prefix: string): HerdrSnapshot {
  const workspaceId = `${prefix}-workspace`;
  const tabId = `${prefix}-tab`;
  return {
    server: { running: true, version: '1.0.0', protocol: 22 },
    focused_workspace_id: workspaceId,
    focused_tab_id: tabId,
    focused_pane_id: `${prefix}-pane`,
    agents: [],
    workspaces: [workspace(workspaceId, tabId, true)],
    tabs: [tab(tabId, workspaceId, true)],
    panes: [pane(`${prefix}-pane`, workspaceId, tabId, true)],
    layouts: [],
  };
}

function nativeState(revision: number, overrides: Partial<HostRuntimeState> = {}): HostRuntimeState {
  return {
    revision,
    connectionGeneration: 2,
    syncGeneration: 3,
    syncStatus: 'synced',
    freshness: 'fresh',
    needsResync: false,
    focus: {},
    ...overrides,
  };
}

describe('live host render cache', () => {
  test('accepts only monotonically newer Rust HostState projections', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const current = applyNativeHostState(opened, 'live-1', nativeState(7), snapshot('new'));
    const stale = applyNativeHostState(current, 'live-1', nativeState(6), snapshot('old'));

    expect(stale).toBe(current);
    expect(findLiveHostSession(current, 'live-1')).toMatchObject({
      snapshot: { focused_pane_id: 'new-pane' },
      sync: { revision: 7, connectionGeneration: 2, generation: 3, freshness: 'fresh' },
    });
  });

  test('retains known-good native projection when freshness becomes stale', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const value = snapshot('known');
    const current = applyNativeHostState(opened, 'live-1', nativeState(1), value);
    const stale = applyNativeHostState(current, 'live-1', nativeState(2, {
      syncStatus: 'error',
      freshness: 'stale',
      error: 'snapshot unavailable',
    }), value);

    expect(findLiveHostSession(stale, 'live-1')).toMatchObject({
      snapshot: { focused_pane_id: 'known-pane' },
      sync: { status: 'error', freshness: 'stale', error: 'snapshot unavailable' },
    });
  });

  test('keeps mobile workspace selection separate from server focus', () => {
    const first = snapshot('server');
    const secondWorkspace = workspace('mobile-workspace', 'mobile-tab');
    first.workspaces.push(secondWorkspace);
    first.tabs.push(tab('mobile-tab', 'mobile-workspace'));
    first.panes.push(pane('mobile-pane', 'mobile-workspace', 'mobile-tab'));
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const projected = applyNativeHostState(opened, 'live-1', nativeState(1), first);
    const selected = selectLiveHostWorkspaceView(projected, 'live-1', 'mobile-workspace');
    const next = applyNativeHostState(selected, 'live-1', nativeState(2), first);
    const session = findLiveHostSession(next, 'live-1')!;

    expect(session.selection.workspaceId).toBe('mobile-workspace');
    expect(session.snapshot.focused_workspace_id).toBe('server-workspace');
  });

  test('repairs an invalid UI selection from the native server focus projection', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const first = applyNativeHostState(opened, 'live-1', nativeState(1), snapshot('first'));
    const selected = selectLiveHostWorkspaceView(first, 'live-1', 'first-workspace');
    const replaced = applyNativeHostState(selected, 'live-1', nativeState(2), snapshot('second'));

    expect(findLiveHostSession(replaced, 'live-1')?.selection).toEqual({
      workspaceId: 'second-workspace',
      tabId: 'second-tab',
      paneId: 'second-pane',
    });
  });

  test('keeps host session rail state independent across hosts', () => {
    const first = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const second = openLiveHostSession(first, host('builder'), 'live-2');
    const projected = applyNativeHostState(second, 'live-1', nativeState(1), snapshot('savior'));

    expect(projected.sessions.map(session => session.id)).toEqual(['live-1', 'live-2']);
    expect(findLiveHostSession(projected, 'live-1')?.snapshot.server.running).toBe(true);
    expect(findLiveHostSession(projected, 'live-2')?.snapshot.server.running).toBe(false);
  });

  test('keeps session selection and close behavior UI-local', () => {
    const first = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const second = openLiveHostSession(first, host('savior'), 'live-2');
    const third = openLiveHostSession(second, host('builder'), 'live-3');

    expect(selectLiveHost(third, 'savior').activeSessionId).toBe('live-2');
    expect(selectLiveHostSession(third, 'live-1').activeSessionId).toBe('live-1');
    expect(selectLiveHostSession(third, 'missing')).toBe(third);
    expect(getActiveLiveHostSession(third)?.id).toBe('live-3');
    expect(closeLiveHostSession(third, 'live-3').activeSessionId).toBe('live-2');
  });

  test('connection display changes do not independently mutate domain freshness', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const projected = applyNativeHostState(opened, 'live-1', nativeState(1), snapshot('known'));
    const reconnecting = updateLiveHostConnection(projected, 'live-1', {
      status: 'reconnecting',
      error: 'connection lost',
      reconnectAttempt: 2,
    });

    expect(findLiveHostSession(reconnecting, 'live-1')).toMatchObject({
      status: 'reconnecting',
      reconnectAttempt: 2,
      sync: { freshness: 'fresh' },
    });
  });

  test('refresh eligibility and preferred pane remain UI projection helpers', () => {
    const connecting = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    expect(canRefreshLiveHostSession(findLiveHostSession(connecting, 'live-1'))).toBe(false);
    const connected = updateLiveHostConnection(connecting, 'live-1', { status: 'connected' });
    expect(canRefreshLiveHostSession(findLiveHostSession(connected, 'live-1'))).toBe(true);
    expect(preferredWorkspacePane(snapshot('savior'), 'savior-workspace')?.pane_id)
      .toBe('savior-pane');
  });
});
