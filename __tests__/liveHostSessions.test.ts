import {
  applyLiveHostFocus,
  applyLiveHostSnapshot,
  beginLiveHostSync,
  closeLiveHostSession,
  emptyLiveHostSessions,
  failLiveHostSync,
  findLiveHostSession,
  getActiveLiveHostSession,
  openLiveHostSession,
  selectLiveHost,
  selectLiveHostPane,
  selectLiveHostSession,
  selectLiveHostTab,
  selectLiveHostWorkspace,
  updateLiveHostConnection,
  updateLiveHostTerminals,
} from '../src/liveHostSessions';
import { openTerminalSession } from '../src/terminalSessions';
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
    rememberCredentials: true,
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

function pane(id: string, terminalId: string, workspaceId: string, tabId: string, focused = false): PaneInfo {
  return {
    pane_id: id,
    terminal_id: terminalId,
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
    server: { running: true, version: '1.0.0' },
    agents: [],
    workspaces: [workspace(workspaceId, tabId, true)],
    tabs: [tab(tabId, workspaceId, true)],
    panes: [pane(`${prefix}-pane`, `${prefix}-terminal`, workspaceId, tabId, true)],
  };
}

function syncSnapshot(
  state: ReturnType<typeof openLiveHostSession>,
  sessionId: string,
  value: HerdrSnapshot,
) {
  const request = beginLiveHostSync(state, sessionId);
  return applyLiveHostSnapshot(request.state, sessionId, request.generation, value, '2026-02-01T00:00:00.000Z');
}

describe('live host session state', () => {
  test('opens multiple hosts concurrently and keeps their state independent', () => {
    const first = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const second = openLiveHostSession(first, host('builder'), 'live-2');
    const withFirstSnapshot = syncSnapshot(second, 'live-1', snapshot('savior'));

    expect(withFirstSnapshot.sessions.map(session => session.id)).toEqual(['live-1', 'live-2']);
    expect(withFirstSnapshot.activeSessionId).toBe('live-2');
    expect(findLiveHostSession(withFirstSnapshot, 'live-1')?.snapshot.server.running).toBe(true);
    expect(findLiveHostSession(withFirstSnapshot, 'live-2')?.snapshot.server.running).toBe(false);
  });

  test('selects sessions directly or by saved host without accepting unknown ids', () => {
    const first = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const second = openLiveHostSession(first, host('savior'), 'live-2');
    const third = openLiveHostSession(second, host('builder'), 'live-3');

    expect(selectLiveHost(third, 'savior').activeSessionId).toBe('live-2');
    expect(selectLiveHostSession(third, 'live-1').activeSessionId).toBe('live-1');
    expect(selectLiveHostSession(third, 'missing')).toBe(third);
    expect(getActiveLiveHostSession(third)?.id).toBe('live-3');
  });

  test('tracks connection and reconnect status per host and marks old snapshots stale', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', snapshot('savior'));
    const connected = updateLiveHostConnection(synced, 'live-1', { status: 'connected' });
    const reconnecting = updateLiveHostConnection(connected, 'live-1', {
      status: 'reconnecting',
      error: 'connection lost',
      reconnectAttempt: 2,
    });

    expect(findLiveHostSession(reconnecting, 'live-1')).toMatchObject({
      status: 'reconnecting',
      connectionError: 'connection lost',
      reconnectAttempt: 2,
      sync: { status: 'stale' },
    });
  });

  test('rejects stale snapshot responses and stale sync failures', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const first = beginLiveHostSync(opened, 'live-1');
    const second = beginLiveHostSync(first.state, 'live-1');
    const staleResult = applyLiveHostSnapshot(
      second.state,
      'live-1',
      first.generation,
      snapshot('old'),
    );
    const staleFailure = failLiveHostSync(staleResult, 'live-1', first.generation, 'old failure');
    const current = applyLiveHostSnapshot(
      staleFailure,
      'live-1',
      second.generation,
      snapshot('new'),
      '2026-02-02T00:00:00.000Z',
    );

    expect(findLiveHostSession(current, 'live-1')).toMatchObject({
      snapshot: { panes: [{ pane_id: 'new-pane' }] },
      sync: {
        status: 'synced',
        generation: second.generation,
        error: null,
        lastSyncedAt: '2026-02-02T00:00:00.000Z',
      },
    });
  });

  test('derives workspace, tab, and pane selection from each snapshot', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', snapshot('savior'));

    expect(findLiveHostSession(synced, 'live-1')?.selection).toEqual({
      workspaceId: 'savior-workspace',
      tabId: 'savior-tab',
      paneId: 'savior-pane',
    });
  });

  test('follows authoritative focus when a newer snapshot arrives', () => {
    const first: HerdrSnapshot = {
      server: { running: true },
      agents: [],
      workspaces: [workspace('w1', 't1', true)],
      tabs: [tab('t1', 'w1', true), tab('t2', 'w1')],
      panes: [pane('p1', 'term-1', 'w1', 't1', true), pane('p2', 'term-2', 'w1', 't2')],
    };
    const second: HerdrSnapshot = {
      ...first,
      workspaces: [workspace('w1', 't2', true)],
      tabs: [tab('t1', 'w1'), tab('t2', 'w1', true)],
      panes: [pane('p1', 'term-1', 'w1', 't1'), pane('p2', 'term-2', 'w1', 't2', true)],
    };
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', first);
    const request = beginLiveHostSync(synced, 'live-1');
    const focused = applyLiveHostSnapshot(request.state, 'live-1', request.generation, second);

    expect(findLiveHostSession(focused, 'live-1')?.selection).toEqual({
      workspaceId: 'w1',
      tabId: 't2',
      paneId: 'p2',
    });
  });

  test('applies pane focus events immediately and updates the full hierarchy', () => {
    const value: HerdrSnapshot = {
      server: { running: true },
      agents: [],
      workspaces: [workspace('w1', 't1', true)],
      tabs: [tab('t1', 'w1', true), tab('t2', 'w1')],
      panes: [pane('p1', 'term-1', 'w1', 't1', true), pane('p2', 'term-2', 'w1', 't2')],
    };
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', value);
    const focused = applyLiveHostFocus(synced, 'live-1', { paneId: 'p2' });
    const session = findLiveHostSession(focused, 'live-1');

    expect(session?.selection).toEqual({ workspaceId: 'w1', tabId: 't2', paneId: 'p2' });
    expect(session?.snapshot.workspaces[0].active_tab_id).toBe('t2');
    expect(session?.snapshot.tabs.find(item => item.tab_id === 't2')?.focused).toBe(true);
    expect(session?.snapshot.panes.find(item => item.pane_id === 'p2')?.focused).toBe(true);
  });

  test('selecting workspace, tab, or pane keeps the hierarchy internally consistent', () => {
    const value: HerdrSnapshot = {
      server: { running: true },
      agents: [],
      workspaces: [workspace('w1', 't1', true), workspace('w2', 't2')],
      tabs: [tab('t1', 'w1', true), tab('t2', 'w2')],
      panes: [pane('p1', 'term-1', 'w1', 't1', true), pane('p2', 'term-2', 'w2', 't2', true)],
    };
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', value);
    const byWorkspace = selectLiveHostWorkspace(synced, 'live-1', 'w2');
    const byTab = selectLiveHostTab(byWorkspace, 'live-1', 't1');
    const byPane = selectLiveHostPane(byTab, 'live-1', 'p2');

    expect(findLiveHostSession(byWorkspace, 'live-1')?.selection).toEqual({ workspaceId: 'w2', tabId: 't2', paneId: 'p2' });
    expect(findLiveHostSession(byTab, 'live-1')?.selection).toEqual({ workspaceId: 'w1', tabId: 't1', paneId: 'p1' });
    expect(findLiveHostSession(byPane, 'live-1')?.selection).toEqual({ workspaceId: 'w2', tabId: 't2', paneId: 'p2' });
  });

  test('owns an independent terminal collection for every live host', () => {
    const first = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const second = openLiveHostSession(first, host('builder'), 'live-2');
    const updated = updateLiveHostTerminals(second, 'live-1', terminals => (
      openTerminalSession(terminals, pane('p1', 'term-1', 'w1', 't1'))
    ));

    expect(findLiveHostSession(updated, 'live-1')?.terminals.sessions).toHaveLength(1);
    expect(findLiveHostSession(updated, 'live-2')?.terminals.sessions).toHaveLength(0);
  });

  test('closing the active host falls back to the last surviving session', () => {
    const one = openLiveHostSession(emptyLiveHostSessions, host('one'), 'live-1');
    const two = openLiveHostSession(one, host('two'), 'live-2');
    const three = openLiveHostSession(two, host('three'), 'live-3');
    const selected = selectLiveHostSession(three, 'live-2');
    const closed = closeLiveHostSession(selected, 'live-2');
    const lastClosed = closeLiveHostSession(closeLiveHostSession(closed, 'live-3'), 'live-1');

    expect(closed.sessions.map(session => session.id)).toEqual(['live-1', 'live-3']);
    expect(closed.activeSessionId).toBe('live-3');
    expect(lastClosed).toEqual({ sessions: [], activeSessionId: null });
  });
});
