import {
  applyLiveHostFocus,
  applyLiveHostAgentStatus,
  applyLiveHostLayoutUpdate,
  applyLiveHostLatency,
  applyLiveHostPaneUpdate,
  applyLiveHostSnapshot,
  applyLiveHostTabCreation,
  applyLiveHostWorkspaceCreation,
  aggregateAgentStatus,
  beginLiveHostSync,
  canRefreshLiveHostSession,
  closeLiveHostSession,
  emptyLiveHostSessions,
  failLiveHostSync,
  findLiveHostSession,
  getActiveLiveHostSession,
  invalidateLiveHostLatency,
  openLiveHostSession,
  preferredWorkspacePane,
  selectLiveHost,
  selectLiveHostSession,
  updateLiveHostConnection,
  updateLiveHostTerminals,
} from '../src/liveHostSessions';
import { initialLatencyWarningState } from '../src/lib/latencyWarning';
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
    focused_workspace_id: workspaceId,
    focused_tab_id: tabId,
    focused_pane_id: `${prefix}-pane`,
    agents: [],
    workspaces: [workspace(workspaceId, tabId, true)],
    tabs: [tab(tabId, workspaceId, true)],
    panes: [pane(`${prefix}-pane`, `${prefix}-terminal`, workspaceId, tabId, true)],
    layouts: [],
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
  test('projects authoritative workspace creation resources and focus immediately', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', snapshot('old'));
    const createdWorkspace = workspace('workspace-new', 'tab-new', true);
    const createdTab = tab('tab-new', 'workspace-new', true);
    const rootPane = pane('pane-new', 'terminal-new', 'workspace-new', 'tab-new', true);

    const updated = applyLiveHostWorkspaceCreation(synced, 'live-1', {
      workspace: createdWorkspace,
      tab: createdTab,
      root_pane: rootPane,
    });
    const session = findLiveHostSession(updated, 'live-1')!;

    expect(session.selection).toEqual({
      workspaceId: 'workspace-new',
      tabId: 'tab-new',
      paneId: 'pane-new',
    });
    expect(session.snapshot.workspaces).toContainEqual(createdWorkspace);
    expect(session.snapshot.tabs).toContainEqual(createdTab);
    expect(session.snapshot.panes).toContainEqual(rootPane);
  });

  test('projects authoritative tab creation resources and focus immediately', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', snapshot('old'));
    const createdTab = tab('tab-new', 'old-workspace', true);
    const rootPane = pane('pane-new', 'terminal-new', 'old-workspace', 'tab-new', true);

    const updated = applyLiveHostTabCreation(synced, 'live-1', {
      tab: createdTab,
      root_pane: rootPane,
    });
    const session = findLiveHostSession(updated, 'live-1')!;

    expect(session.selection).toEqual({
      workspaceId: 'old-workspace',
      tabId: 'tab-new',
      paneId: 'pane-new',
    });
    expect(session.snapshot.workspaces[0].active_tab_id).toBe('tab-new');
    expect(session.snapshot.tabs).toContainEqual(createdTab);
    expect(session.snapshot.panes).toContainEqual(rootPane);
  });

  test('aggregates agent attention with native-client priority', () => {
    expect(aggregateAgentStatus([])).toBe('unknown');
    expect(aggregateAgentStatus(['idle', 'working'])).toBe('working');
    expect(aggregateAgentStatus(['working', 'done'])).toBe('done');
    expect(aggregateAgentStatus(['done', 'blocked'])).toBe('blocked');
  });

  test('does not refresh a host until its initial SSH connection is established', () => {
    const connecting = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const session = findLiveHostSession(connecting, 'live-1');

    expect(canRefreshLiveHostSession(session)).toBe(false);
    expect(canRefreshLiveHostSession(
      findLiveHostSession(updateLiveHostConnection(connecting, 'live-1', { status: 'connected' }), 'live-1'),
    )).toBe(true);
    expect(canRefreshLiveHostSession(
      findLiveHostSession(updateLiveHostConnection(connecting, 'live-1', { status: 'ready' }), 'live-1'),
    )).toBe(true);
    expect(canRefreshLiveHostSession(
      findLiveHostSession(updateLiveHostConnection(connecting, 'live-1', { status: 'reconnecting' }), 'live-1'),
    )).toBe(true);
  });

  test('opens multiple hosts concurrently and keeps their state independent', () => {
    const first = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const second = openLiveHostSession(first, host('builder'), 'live-2');
    const withFirstSnapshot = syncSnapshot(second, 'live-1', snapshot('savior'));

    expect(withFirstSnapshot.sessions.map(session => session.id)).toEqual(['live-1', 'live-2']);
    expect(withFirstSnapshot.activeSessionId).toBe('live-2');
    expect(findLiveHostSession(withFirstSnapshot, 'live-1')?.snapshot.server.running).toBe(true);
    expect(findLiveHostSession(withFirstSnapshot, 'live-2')?.snapshot.server.running).toBe(false);
  });

  test('can restore a background host without changing the active session', () => {
    const first = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const second = openLiveHostSession(first, host('builder'), 'live-2', false);

    expect(second.sessions.map(session => session.id)).toEqual(['live-1', 'live-2']);
    expect(second.activeSessionId).toBe('live-1');
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
    const ready = updateLiveHostConnection(synced, 'live-1', { status: 'ready' });
    const reconnecting = updateLiveHostConnection(ready, 'live-1', {
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

  test('preserves state identity for a redundant ready connection update', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const ready = updateLiveHostConnection(opened, 'live-1', { status: 'ready' });

    expect(updateLiveHostConnection(ready, 'live-1', { status: 'ready' })).toBe(ready);
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

  test('tracks the latest successful control-channel latency for each host', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const ready = updateLiveHostConnection(opened, 'live-1', { status: 'ready' });
    const request = beginLiveHostSync(ready, 'live-1');
    const synced = applyLiveHostSnapshot(
      request.state,
      'live-1',
      request.generation,
      snapshot('savior'),
      '2026-02-02T00:00:00.000Z',
      42,
    );

    expect(findLiveHostSession(synced, 'live-1')?.sync.latencyMs).toBe(42);
  });

  test('updates latency independently without changing snapshot sync metadata', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const ready = updateLiveHostConnection(opened, 'live-1', { status: 'ready' });
    const request = beginLiveHostSync(ready, 'live-1');
    const synced = applyLiveHostSnapshot(
      request.state,
      'live-1',
      request.generation,
      snapshot('savior'),
      '2026-02-02T00:00:00.000Z',
      42,
    );

    const updated = applyLiveHostLatency(synced, 'live-1', 18);

    expect(findLiveHostSession(updated, 'live-1')?.sync).toEqual({
      status: 'synced',
      generation: request.generation,
      error: null,
      lastSyncedAt: '2026-02-02T00:00:00.000Z',
      latencyMs: 18,
      latencyWarning: initialLatencyWarningState,
    });
  });

  test('tracks repeated latency samples so sustained high latency can warn', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const ready = updateLiveHostConnection(opened, 'live-1', { status: 'ready' });
    const first = applyLiveHostLatency(ready, 'live-1', 200);
    const second = applyLiveHostLatency(first, 'live-1', 200);

    expect(findLiveHostSession(first, 'live-1')?.sync.latencyWarning.active).toBe(false);
    expect(findLiveHostSession(second, 'live-1')?.sync.latencyWarning.active).toBe(true);
  });

  test('invalidates a stale successful latency after a liveness failure', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const ready = updateLiveHostConnection(opened, 'live-1', { status: 'ready' });
    const request = beginLiveHostSync(ready, 'live-1');
    const synced = applyLiveHostSnapshot(
      request.state,
      'live-1',
      request.generation,
      snapshot('savior'),
      '2026-02-02T00:00:00.000Z',
      15,
    );

    const invalidated = invalidateLiveHostLatency(synced, 'live-1');

    expect(findLiveHostSession(invalidated, 'live-1')?.sync).toMatchObject({
      status: 'stale',
      latencyMs: null,
      latencyWarning: initialLatencyWarningState,
    });
  });

  test('clears the latency warning when the host connection is lost', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const ready = updateLiveHostConnection(opened, 'live-1', { status: 'ready' });
    const first = applyLiveHostLatency(ready, 'live-1', 250);
    const warned = applyLiveHostLatency(first, 'live-1', 250);
    const reconnecting = updateLiveHostConnection(warned, 'live-1', { status: 'reconnecting' });

    expect(findLiveHostSession(reconnecting, 'live-1')?.sync).toMatchObject({
      latencyMs: null,
      latencyWarning: initialLatencyWarningState,
    });
  });

  test('ignores latency samples until connected hosts are hydrated', () => {
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const connected = updateLiveHostConnection(opened, 'live-1', { status: 'connected' });
    expect(applyLiveHostLatency(opened, 'live-1', 18)).toBe(opened);
    expect(applyLiveHostLatency(connected, 'live-1', 18)).toBe(connected);
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

  test('resolves the active pane for an agentless workspace', () => {
    const value = snapshot('shell');
    value.agents = [];
    value.tabs[0].agent_status = 'unknown';
    value.panes[0].agent_status = 'unknown';

    expect(preferredWorkspacePane(value, 'shell-workspace')).toEqual(
      expect.objectContaining({
        pane_id: 'shell-pane',
        terminal_id: 'shell-terminal',
      }),
    );
  });

  test('follows authoritative focus when a newer snapshot arrives', () => {
    const first: HerdrSnapshot = {
      server: { running: true },
      focused_workspace_id: 'w1',
      focused_tab_id: 't1',
      focused_pane_id: 'p1',
      agents: [],
      workspaces: [workspace('w1', 't1', true)],
      tabs: [tab('t1', 'w1', true), tab('t2', 'w1')],
      panes: [pane('p1', 'term-1', 'w1', 't1', true), pane('p2', 'term-2', 'w1', 't2')],
      layouts: [],
    };
    const second: HerdrSnapshot = {
      ...first,
      focused_tab_id: 't2',
      focused_pane_id: 'p2',
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
      focused_workspace_id: 'w1',
      focused_tab_id: 't1',
      focused_pane_id: 'p1',
      agents: [],
      workspaces: [workspace('w1', 't1', true)],
      tabs: [tab('t1', 'w1', true), tab('t2', 'w1')],
      panes: [pane('p1', 'term-1', 'w1', 't1', true), pane('p2', 'term-2', 'w1', 't2')],
      layouts: [],
    };
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', value);
    const focused = applyLiveHostFocus(synced, 'live-1', { paneId: 'p2' });
    const session = findLiveHostSession(focused, 'live-1');

    expect(session?.selection).toEqual({ workspaceId: 'w1', tabId: 't2', paneId: 'p2' });
    expect(session?.snapshot.workspaces[0].active_tab_id).toBe('t2');
    expect(session?.snapshot.tabs.find(item => item.tab_id === 't2')?.focused).toBe(true);
    expect(session?.snapshot.panes.find(item => item.pane_id === 'p2')?.focused).toBe(true);
    expect(session?.snapshot.focused_tab_id).toBe('t2');
    expect(session?.snapshot.focused_pane_id).toBe('p2');
  });

  test('applies agent, pane, and layout events immediately', () => {
    const value = snapshot('savior');
    const paneId = 'savior-pane';
    value.agents = [{
      terminal_id: 'savior-terminal',
      agent: 'codex',
      agent_status: 'working',
      workspace_id: 'savior-workspace',
      tab_id: 'savior-tab',
      pane_id: paneId,
      focused: true,
      revision: 1,
    }];
    value.panes[0].agent_status = 'working';
    value.tabs[0].agent_status = 'working';
    value.workspaces[0].agent_status = 'working';
    const opened = openLiveHostSession(emptyLiveHostSessions, host('savior'), 'live-1');
    const synced = syncSnapshot(opened, 'live-1', value);
    const status = applyLiveHostAgentStatus(synced, 'live-1', paneId, {
      agent_status: 'done',
      title: 'Finished',
    });
    const paneUpdated = applyLiveHostPaneUpdate(status, 'live-1', {
      ...value.panes[0],
      agent_status: 'done',
      terminal_title: 'New terminal title',
      revision: 2,
    });
    const layout = {
      workspace_id: 'savior-workspace',
      tab_id: 'savior-tab',
      zoomed: false,
      area: { x: 0, y: 0, width: 80, height: 24 },
      focused_pane_id: paneId,
      panes: [{ pane_id: paneId, focused: true, rect: { x: 0, y: 0, width: 80, height: 24 } }],
      splits: [],
    };
    const laidOut = applyLiveHostLayoutUpdate(paneUpdated, 'live-1', layout);
    const session = findLiveHostSession(laidOut, 'live-1');

    expect(session?.snapshot.agents[0]).toMatchObject({ agent_status: 'done', title: 'Finished' });
    expect(session?.snapshot.panes[0]).toMatchObject({ agent_status: 'done', terminal_title: 'New terminal title' });
    expect(session?.snapshot.tabs[0].agent_status).toBe('done');
    expect(session?.snapshot.workspaces[0].agent_status).toBe('done');
    expect(session?.snapshot.layouts).toEqual([layout]);
  });

  test('keeps unaffected tabs and workspaces referentially stable on agent events', () => {
    const value: HerdrSnapshot = {
      server: { running: true },
      focused_workspace_id: 'w1',
      focused_tab_id: 't1',
      focused_pane_id: 'p1',
      agents: [
        {
          terminal_id: 'term-1',
          agent: 'codex',
          agent_status: 'working',
          workspace_id: 'w1',
          tab_id: 't1',
          pane_id: 'p1',
          focused: true,
          revision: 1,
        },
      ],
      workspaces: [workspace('w1', 't1', true), workspace('w2', 't2')],
      tabs: [tab('t1', 'w1', true), tab('t2', 'w2')],
      panes: [
        pane('p1', 'term-1', 'w1', 't1', true),
        pane('p2', 'term-2', 'w2', 't2'),
      ],
      layouts: [],
    };
    value.panes[0].agent_status = 'working';
    value.tabs[0].agent_status = 'working';
    value.workspaces[0].agent_status = 'working';
    const opened = openLiveHostSession(
      emptyLiveHostSessions,
      host('savior'),
      'live-1',
    );
    const synced = syncSnapshot(opened, 'live-1', value);
    const before = findLiveHostSession(synced, 'live-1')!.snapshot;
    const updated = applyLiveHostAgentStatus(synced, 'live-1', 'p1', {
      agent_status: 'done',
    });
    const after = findLiveHostSession(updated, 'live-1')!.snapshot;

    expect(after.tabs[0]).toMatchObject({ tab_id: 't1', agent_status: 'done' });
    expect(after.workspaces[0]).toMatchObject({
      workspace_id: 'w1',
      agent_status: 'done',
    });
    expect(after.tabs[1]).toBe(before.tabs[1]);
    expect(after.workspaces[1]).toBe(before.workspaces[1]);
    expect(after.panes[1]).toBe(before.panes[1]);
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
