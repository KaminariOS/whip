import type {
  AppCoreProjection,
  HostRuntimeState,
} from 'react-native-whip-ssh';

import {
  emptyLiveHostSessions,
  projectAppCoreSessions,
} from '../src/liveHostSessions';
import type { HerdrSnapshot, HostProfile } from '../src/types';

const host: HostProfile = {
  id: 'savior',
  name: 'Savior',
  host: 'savior.example.test',
  port: '22',
  username: 'herdr',
  authMode: 'key',
  herdrCommand: 'herdr',
  sessionName: 'main',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const hostState: HostRuntimeState = {
  revision: 7,
  connectionGeneration: 2,
  syncGeneration: 3,
  syncStatus: 'synced',
  freshness: 'fresh',
  needsResync: false,
  focus: {
    workspaceId: 'workspace-1',
    tabId: 'tab-1',
    paneId: 'pane-1',
  },
};

function coreView(): AppCoreProjection {
  return {
    revision: 4,
    activeSessionId: 'live-1',
    sessions: [{
      id: 'live-1',
      hostId: host.id,
      connectionStatus: 'ready',
      reconnectAttempt: 0,
      selection: {
        workspaceId: 'workspace-1',
        tabId: 'tab-1',
        paneId: 'pane-1',
      },
      hostState,
      terminalRail: { terminals: [] },
    }],
  };
}

describe('Rust AppCore render projection', () => {
  test('mechanically maps the typed native view into the React cache', () => {
    const snapshot: HerdrSnapshot = {
      server: { running: true },
      focused_workspace_id: 'workspace-1',
      focused_tab_id: 'tab-1',
      focused_pane_id: 'pane-1',
      agents: [],
      workspaces: [],
      tabs: [],
      panes: [],
      layouts: [],
    };

    const projected = projectAppCoreSessions(
      coreView(),
      new Map([[host.id, host]]),
      emptyLiveHostSessions,
      (_sessionId, state) => {
        expect(state).toBe(hostState);
        return snapshot;
      },
    );

    expect(projected).toEqual({
      activeSessionId: 'live-1',
      sessions: [expect.objectContaining({
        id: 'live-1',
        host,
        status: 'ready',
        snapshot,
        selection: {
          workspaceId: 'workspace-1',
          tabId: 'tab-1',
          paneId: 'pane-1',
        },
        sync: expect.objectContaining({
          revision: 7,
          generation: 3,
          freshness: 'fresh',
        }),
      })],
    });
  });

  test('does not silently accept an unknown Rust host projection', () => {
    expect(() => projectAppCoreSessions(
      coreView(),
      new Map(),
      emptyLiveHostSessions,
      () => { throw new Error('unreachable'); },
    )).toThrow('Rust AppCore projected unknown host savior');
  });
});
