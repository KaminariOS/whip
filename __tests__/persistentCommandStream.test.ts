import SSHClient from 'react-native-whip-ssh';

import {
  clearHerdrSocketPathCache,
  HerdrClient,
} from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => (
  require('./mockWhipSsh').createMockWhipSshModule()
));

const connectWithPassword = jest.mocked(SSHClient.connectWithPassword);

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Test host',
  host: 'host.example.test',
  port: '22',
  username: 'herdr',
  authMode: 'password',
  secret: 'secret',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: 'main',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

type SemanticTestClient = SSHClient & {
  createTabWithLaunch: jest.Mock;
  submitPastes: jest.Mock;
  startHerdrServer: jest.Mock;
  measureHostLatency: jest.Mock;
};

function apiClient(responseFor: (request: { method: string; params: Record<string, unknown> }) => unknown | Promise<unknown>) {
  const requestHerdrApi = jest.fn(async (_socketPath: string, request: { method: string; params: Record<string, unknown> }) => {
    const result = await responseFor(request);
    if (result instanceof Error) throw result.message;
    return result;
  });
  return {
    requestHerdrApi,
    createTabWithLaunch: jest.fn(async (
      workspaceId: string,
      label: string,
      launch: Record<string, unknown>,
    ) => {
      const result = await responseFor({
        method: 'runtime.tab.launch',
        params: { workspaceId, label, launch },
      });
      if (result instanceof Error) throw result;
      return result;
    }),
    submitPastes: jest.fn(async () => undefined),
    startHerdrServer: jest.fn(async () => undefined),
    measureHostLatency: jest.fn(async () => ({
      sshRttMs: 42,
      totalMs: 43,
      runtimeOverheadMs: 1,
    })),
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SemanticTestClient;
}

function tabCreated(paneId: string, label: string) {
  return {
    type: 'tab_created',
    tab: {
      tab_id: `tab-${paneId}`,
      workspace_id: 'space-1',
      number: 2,
      label,
      focused: true,
      pane_count: 1,
      agent_status: 'idle',
    },
    root_pane: {
      pane_id: paneId,
      terminal_id: `terminal-${paneId}`,
      workspace_id: 'space-1',
      tab_id: `tab-${paneId}`,
      focused: true,
      agent_status: 'idle',
      revision: 0,
    },
  };
}

describe('direct Herdr API requests', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
    clearHerdrSocketPathCache();
  });

  test('sends control operations directly to the Unix socket', async () => {
    const native = apiClient(() => ({ type: 'ok' }));
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await client.focusWorkspace('space-1');
    await client.focusTab('tab-1');

    expect(native.requestHerdrApi).toHaveBeenCalledTimes(2);
    expect(native.requestHerdrApi).toHaveBeenNthCalledWith(
      1,
      '/home/herdr/.config/herdr/sessions/main/herdr.sock',
      expect.objectContaining({ method: 'workspace.focus' }),
    );
    expect(native.requestHerdrApi).toHaveBeenNthCalledWith(
      2,
      '/home/herdr/.config/herdr/sessions/main/herdr.sock',
      expect.objectContaining({ method: 'tab.focus' }),
    );
  });

  test('uses the versioned session snapshot as the initial availability probe', async () => {
    const native = apiClient(() => ({
      type: 'session_snapshot',
      snapshot: {
        version: '0.7.4',
        protocol: 17,
        focused_workspace_id: 'w1',
        focused_tab_id: 't1',
        focused_pane_id: 'p1',
        workspaces: [{ workspace_id: 'w1', number: 1, label: 'work', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 't1', agent_status: 'idle' }],
        tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: 'shell', focused: true, pane_count: 1, agent_status: 'idle' }],
        panes: [{ pane_id: 'p1', terminal_id: 'term-1', workspace_id: 'w1', tab_id: 't1', focused: true, agent_status: 'idle', revision: 3 }],
        layouts: [],
        agents: [],
      },
    }));
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.initialSnapshot()).resolves.toMatchObject({
      server: { running: true, version: '0.7.4', protocol: 17 },
      focused_workspace_id: 'w1',
      focused_tab_id: 't1',
      focused_pane_id: 'p1',
      workspaces: [expect.objectContaining({ workspace_id: 'w1' })],
      tabs: [expect.objectContaining({ tab_id: 't1' })],
      panes: [expect.objectContaining({ pane_id: 'p1', terminal_id: 'term-1' })],
    });

    const methods = jest.mocked(native.requestHerdrApi).mock.calls
      .map(([, request]) => request.method);
    expect(methods).toEqual(['session.snapshot']);
  });

  test('measures device-to-host latency instead of a session snapshot', async () => {
    const native = apiClient(request => request.method === 'ping'
      ? { type: 'pong' }
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();
    await expect(client.measureLatency()).resolves.toMatchObject({
      latencyMs: 42,
      sshRttMs: 42,
      totalMs: 43,
      runtimeOverheadMs: 1,
    });

    expect(native.measureHostLatency).toHaveBeenCalledTimes(1);
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
  });

  test('measures host latency independently after native state synchronization', async () => {
    const native = apiClient(request => request.method === 'session.snapshot'
      ? {
        type: 'session_snapshot',
        snapshot: {
          version: '0.7.4',
          protocol: 17,
          workspaces: [],
          tabs: [],
          panes: [],
          layouts: [],
          agents: [],
        },
      }
      : { type: 'pong' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await client.initialSnapshot();
    jest.mocked(native.measureHostLatency).mockResolvedValueOnce({
      sshRttMs: 37,
      totalMs: 37.5,
      runtimeOverheadMs: 0.5,
    });

    await expect(client.measureLatency()).resolves.toMatchObject({
      latencyMs: 37,
      sshRttMs: 37,
      totalMs: 37.5,
      runtimeOverheadMs: 0.5,
    });

    const directMethods = jest.mocked(native.requestHerdrApi).mock.calls
      .map(([, request]) => request.method);
    expect(directMethods).toEqual(['session.snapshot']);
    expect(native.measureHostLatency).toHaveBeenCalledTimes(1);
  });

  test('returns authoritative workspace creation resources', async () => {
    const created = {
      type: 'workspace_created',
      workspace: { workspace_id: 'space-new' },
      tab: { tab_id: 'tab-new' },
      root_pane: { pane_id: 'pane-new' },
    };
    const native = apiClient(() => created);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.createWorkspace(' New space ', ' /repo ')).resolves.toEqual(created);
    const request = jest.mocked(native.requestHerdrApi).mock.calls[0][1];
    expect(request).toMatchObject({
      method: 'workspace.create',
      params: { label: 'New space', cwd: '/repo', focus: true },
    });
  });

  test('launches OpenCode through one typed native operation', async () => {
    const created = tabCreated('pane-new', 'Review');
    const native = apiClient(request => request.method === 'runtime.tab.launch'
      ? created
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.createTabWithLaunch(
      'space-1',
      ' Review ',
      { type: 'agent', kind: 'opencode', args: ['--model', 'current model'] },
    )).resolves.toMatchObject({ root_pane: { pane_id: 'pane-new' } });

    expect(native.createTabWithLaunch).toHaveBeenCalledTimes(1);
    expect(native.createTabWithLaunch).toHaveBeenCalledWith(
      'space-1', ' Review ',
      { type: 'agent', kind: 'opencode', args: ['--model', 'current model'] },
    );
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
  });

  test('keeps an arbitrary command containing codex as an arbitrary command', async () => {
    const created = tabCreated('pane-command', 'Checks');
    const native = apiClient(request => request.method === 'runtime.tab.launch'
      ? created
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.createTabWithLaunch(
      'space-1', ' Checks ', { type: 'command', command: 'echo codex is installed' },
    )).resolves.toEqual(created);

    expect(native.createTabWithLaunch).toHaveBeenCalledWith(
      'space-1', ' Checks ', { type: 'command', command: 'echo codex is installed' },
    );
    expect(native.createTabWithLaunch).toHaveBeenCalledTimes(1);
  });

  test('launches Codex through one typed native operation', async () => {
    const created = tabCreated('pane-codex', 'Codex');
    const native = apiClient(request => request.method === 'runtime.tab.launch'
      ? created
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.createTabWithLaunch(
      'space-1', 'Codex', { type: 'agent', kind: 'codex', args: ['--profile', 'work'] },
    )).resolves.toEqual(created);

    expect(native.createTabWithLaunch).toHaveBeenCalledTimes(1);
    expect(native.createTabWithLaunch).toHaveBeenCalledWith(
      'space-1', 'Codex', { type: 'agent', kind: 'codex', args: ['--profile', 'work'] },
    );
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
  });

  test('createTab focuses and returns the created tab and root pane', async () => {
    const created = tabCreated('pane-tab', 'Notes');
    const native = apiClient(() => created);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.createTab('space-1', ' Notes ')).resolves.toEqual(created);
    const request = jest.mocked(native.requestHerdrApi).mock.calls[0][1];
    expect(request).toMatchObject({
      method: 'tab.create',
      params: { workspace_id: 'space-1', label: 'Notes', focus: true },
    });
  });

  test('creates a normal shell tab through the semantic launch operation', async () => {
    const native = apiClient(request => request.method === 'runtime.tab.launch'
      ? tabCreated('pane-default-name', 'shell')
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.createTabWithLaunch('space-1', '   ', { type: 'shell' }))
      .resolves.toMatchObject({ root_pane: { pane_id: 'pane-default-name' } });

    expect(native.createTabWithLaunch).toHaveBeenCalledWith('space-1', '   ', { type: 'shell' });
  });

  test('reports typed partial success when native agent startup fails without a second JS send', async () => {
    const created = tabCreated('pane-partial', 'Checks');
    const failure = Object.assign(new Error('agent startup failed'), {
      code: 'TAB_LAUNCH_FAILED', created, launchType: 'agent',
    });
    const native = apiClient(request => request.method === 'runtime.tab.launch'
      ? failure
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.createTabWithLaunch(
      'space-1', 'Checks', { type: 'agent', kind: 'codex' },
    )).rejects.toMatchObject({
      name: 'CommandLaunchPartialFailure',
      message: expect.stringContaining('Tab Checks was created, but agent launch failed'),
      created: { root_pane: { pane_id: 'pane-partial' } },
    });
    expect(native.createTabWithLaunch).toHaveBeenCalledTimes(1);
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
  });

  test('propagates native tab creation failure without attempting a launch in JS', async () => {
    const native = apiClient(request => request.method === 'runtime.tab.launch'
      ? Object.assign(new Error('tab creation failed'), { code: 'TAB_CREATION_FAILED' })
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.createTabWithLaunch(
      'space-1', 'Codex', { type: 'agent', kind: 'codex' },
    )).rejects.toThrow('tab creation failed');
    expect(native.createTabWithLaunch).toHaveBeenCalledTimes(1);
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
  });

  test('consolidates a multi-part pane submission into one semantic native call', async () => {
    const native = apiClient(() => ({ type: 'ok' }));
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await client.pasteIntoPane('pane-1', 'a long paste');
    await client.submitPastesToPane('pane-1', ['please inspect', '/tmp/image.png']);

    expect(native.requestHerdrApi).toHaveBeenCalledTimes(1);
    expect(native.submitPastes).toHaveBeenCalledTimes(1);
    expect(native.submitPastes).toHaveBeenCalledWith(
      'pane-1',
      ['please inspect', '/tmp/image.png'],
    );
  });

  test('issues concurrent native requests and preserves multiline UTF-8 output', async () => {
    let resolveRead!: (result: unknown) => void;
    const pendingRead = new Promise<unknown>(resolve => {
      resolveRead = resolve;
    });
    const native = apiClient(request => request.method === 'pane.read'
      ? pendingRead
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    let readSettled = false;
    const readPromise = client.readPane('pane-1', 500).finally(() => {
      readSettled = true;
    });
    const focusPromise = client.focusPane('pane-1');

    await expect(focusPromise).resolves.toBeUndefined();

    expect(native.requestHerdrApi).toHaveBeenCalledTimes(2);
    const requests = jest.mocked(native.requestHerdrApi).mock.calls.map(([, request]) => request);
    expect(requests).toEqual([
      expect.objectContaining({
        method: 'pane.read',
        params: { pane_id: 'pane-1', source: 'recent', lines: 500, format: 'ansi', strip_ansi: false },
      }),
      expect.objectContaining({
        method: 'pane.focus',
        params: { pane_id: 'pane-1' },
      }),
    ]);
    expect(readSettled).toBe(false);

    resolveRead({ type: 'pane_read', read: { text: 'first\n你好' } });
    await expect(readPromise).resolves.toBe('first\n你好');
  });

  test('rejects an in-flight command when the persistent stream closes', async () => {
    const native = {
      requestHerdrApi: jest.fn(async () => { throw 'socket is not established'; }),
      getRemoteHome: jest.fn(async () => '/home/herdr'),
      off: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as SSHClient;
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.createWorkspace('space', '')).rejects.toBe('socket is not established');
  });

  test('rechecks an offline server so a later refresh discovers its workspaces', async () => {
    let snapshotChecks = 0;
    const native = apiClient(request => {
      if (request.method === 'session.snapshot') {
        snapshotChecks += 1;
        if (snapshotChecks <= 4) return new Error('channel is not opened.');
      }
      return { type: 'session_snapshot', snapshot: { version: '0.7.4', protocol: 17, focused_workspace_id: 'w1', focused_tab_id: 't1', focused_pane_id: 'p1', workspaces: [{ workspace_id: 'w1', number: 1, label: 'work', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 't1', agent_status: 'idle' }], tabs: [], panes: [], layouts: [], agents: [] } };
    });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.snapshot()).rejects.toThrow('channel is not opened.');
    expect(client.hostState()).toMatchObject({
      freshness: 'unavailable',
    });
    expect(client.hostState().snapshot).toBeUndefined();
    await expect(client.snapshot()).resolves.toMatchObject({
      server: { running: true },
      workspaces: [{ workspace_id: 'w1', label: 'work' }],
    });
    expect(snapshotChecks).toBe(5);
  });

  test('surfaces a failed refresh instead of reporting an empty Herdr server', async () => {
    const native = {
      requestHerdrApi: jest.fn(async () => { throw 'channel is not opened.'; }),
      getRemoteHome: jest.fn()
        .mockResolvedValueOnce('/home/herdr')
        .mockRejectedValueOnce('session is down'),
      closeAllHerdrBridges: jest.fn(),
      off: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as SSHClient;
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.snapshot()).rejects.toThrow('channel is not opened.');
    expect(client.hostState()).toMatchObject({
      freshness: 'unavailable',
    });
    expect(client.hostState().snapshot).toBeUndefined();
    expect(native.getRemoteHome).toHaveBeenCalledTimes(1);
  });

  test('retries the initial API channel without repeating SSH authentication', async () => {
    let attempts = 0;
    const native = apiClient(() => {
      attempts += 1;
      return attempts === 1
        ? new Error('channel is not opened.')
        : {
          type: 'session_snapshot',
          snapshot: {
            version: '0.7.4',
            protocol: 17,
            focused_workspace_id: 'w1',
            focused_tab_id: null,
            focused_pane_id: null,
            workspaces: [{
              workspace_id: 'w1',
              number: 1,
              label: 'work',
              focused: true,
              pane_count: 0,
              tab_count: 0,
              active_tab_id: null,
              agent_status: 'idle',
            }],
            tabs: [],
            panes: [],
            layouts: [],
            agents: [],
          },
        };
    });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.initialSnapshot()).resolves.toMatchObject({
      server: { running: true },
      workspaces: [{ workspace_id: 'w1', label: 'work' }],
    });
    expect(connectWithPassword).toHaveBeenCalledTimes(1);
    expect(native.requestHerdrApi).toHaveBeenCalledTimes(2);
    expect(native.disconnect).not.toHaveBeenCalled();
  });

  test('opens the offline Herd path after two unavailable channels on the same SSH session', async () => {
    const native = apiClient(() => new Error('channel is not opened.'));
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.initialSnapshot()).resolves.toMatchObject({
      server: { running: false },
      workspaces: [],
    });

    expect(connectWithPassword).toHaveBeenCalledTimes(1);
    expect(native.requestHerdrApi).toHaveBeenCalledTimes(2);
    expect(native.disconnect).not.toHaveBeenCalled();
  });

  test('reuses a resolved socket path for later connections to the same host', async () => {
    const snapshot = {
      type: 'session_snapshot',
      snapshot: {
        version: '0.7.4',
        protocol: 17,
        focused_workspace_id: null,
        focused_tab_id: null,
        focused_pane_id: null,
        workspaces: [],
        tabs: [],
        panes: [],
        layouts: [],
        agents: [],
      },
    };
    const firstNative = apiClient(() => snapshot);
    const secondNative = apiClient(() => snapshot);
    connectWithPassword.mockResolvedValueOnce(firstNative).mockResolvedValueOnce(secondNative);

    const first = new HerdrClient();
    await first.connect(profile);
    await first.initialSnapshot();
    const second = new HerdrClient();
    await second.connect(profile);
    await second.initialSnapshot();

    expect(firstNative.getRemoteHome).toHaveBeenCalledTimes(1);
    expect(secondNative.getRemoteHome).not.toHaveBeenCalled();
    expect(secondNative.requestHerdrApi).toHaveBeenCalledWith(
      '/home/herdr/.config/herdr/sessions/main/herdr.sock',
      expect.objectContaining({ method: 'session.snapshot' }),
    );
  });

  test('invalidates a stale cached socket path and resolves it through the current SSH session', async () => {
    const snapshot = {
      type: 'session_snapshot',
      snapshot: {
        version: '0.7.4',
        protocol: 17,
        focused_workspace_id: null,
        focused_tab_id: null,
        focused_pane_id: null,
        workspaces: [],
        tabs: [],
        panes: [],
        layouts: [],
        agents: [],
      },
    };
    const firstNative = apiClient(() => snapshot);
    connectWithPassword.mockResolvedValueOnce(firstNative);
    const first = new HerdrClient();
    await first.connect(profile);
    await first.initialSnapshot();

    const secondNative = {
      requestHerdrApi: jest.fn(async (socketPath: string, _request: object) => {
        if (socketPath.startsWith('/home/herdr/')) throw 'channel is not opened.';
        return snapshot;
      }),
      getRemoteHome: jest.fn(async () => '/srv/herdr'),
      closeAllHerdrBridges: jest.fn(),
      off: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as SSHClient;
    connectWithPassword.mockResolvedValueOnce(secondNative);
    const second = new HerdrClient();
    await second.connect(profile);

    await expect(second.initialSnapshot()).resolves.toMatchObject({
      server: { running: true, socket: '/srv/herdr/.config/herdr/sessions/main/herdr.sock' },
    });
    expect(secondNative.getRemoteHome).toHaveBeenCalledTimes(1);
    expect(secondNative.requestHerdrApi).toHaveBeenNthCalledWith(
      2,
      '/srv/herdr/.config/herdr/sessions/main/herdr.sock',
      expect.objectContaining({ method: 'session.snapshot' }),
    );
  });
});
