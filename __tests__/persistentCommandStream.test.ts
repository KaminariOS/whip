import SSHClient from 'react-native-whip-ssh';

import {
  classifyAgentCommand,
  clearHerdrSocketPathCache,
  HerdrClient,
} from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({
  __esModule: true,
  default: {
    connectWithPassword: jest.fn(),
    connectWithKey: jest.fn(),
  },
}));

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

function apiClient(responseFor: (request: { method: string; params: Record<string, unknown> }) => unknown | Promise<unknown>) {
  const requestHerdrApi = jest.fn(async (_socketPath: string, request: { method: string; params: Record<string, unknown> }) => {
    const result = await responseFor(request);
    if (result instanceof Error) throw result.message;
    return result;
  });
  return {
    requestHerdrApi,
    measureHostLatency: jest.fn(async () => 42),
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
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
    await expect(client.measureLatency()).resolves.toMatchObject({
      latencyMs: 42,
      sshRttMs: 42,
      totalMs: 42,
      dispatchMs: 0,
    });

    expect(native.measureHostLatency).toHaveBeenCalledTimes(1);
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
  });

  test('measures host latency independently while the event subscription is open', async () => {
    const native = Object.assign(apiClient(request => request.method === 'session.snapshot'
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
      : { type: 'pong' }), {
      startHerdrEventStream: jest.fn(async () => undefined),
      closeHerdrEventStream: jest.fn(),
    });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await client.initialSnapshot();
    await client.openEventStream([], jest.fn());
    jest.mocked(native.measureHostLatency).mockResolvedValueOnce(37);

    await expect(client.measureLatency()).resolves.toMatchObject({
      latencyMs: 37,
      sshRttMs: 37,
      totalMs: 37,
      dispatchMs: 0,
    });

    const directMethods = jest.mocked(native.requestHerdrApi).mock.calls
      .map(([, request]) => request.method);
    expect(directMethods).toEqual(['session.snapshot']);
    expect(native.measureHostLatency).toHaveBeenCalledTimes(1);
    expect(native.startHerdrEventStream).toHaveBeenCalledWith(
      '/home/herdr/.config/herdr/sessions/main/herdr.sock',
      17,
      [],
      expect.any(Function),
    );
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

    await expect(client.createWorkspace(' New space ', ' /repo ')).resolves.toEqual(created);
    const request = jest.mocked(native.requestHerdrApi).mock.calls[0][1];
    expect(request).toMatchObject({
      method: 'workspace.create',
      params: { label: 'New space', cwd: '/repo', focus: true },
    });
  });

  test('starts the recognized default OpenCode agent in a named tab without renaming its root pane', async () => {
    const native = apiClient(request => request.method === 'tab.create'
      ? tabCreated('pane-new', 'Review')
      : request.method === 'agent.start'
        ? { type: 'agent_started', agent: {}, argv: ['opencode'] }
        : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.createTabAndLaunchCommand(
      'space-1',
      ' Review ',
      ' opencode --model "current model" ',
    )).resolves.toMatchObject({ root_pane: { pane_id: 'pane-new' } });

    const requests = jest.mocked(native.requestHerdrApi).mock.calls.map(([, request]) => request);
    expect(requests.map(request => request.method)).toEqual(['tab.create', 'agent.start']);
    expect(requests[0].params).toEqual({
      workspace_id: 'space-1',
      label: 'Review',
      focus: true,
    });
    expect(requests[1].params).toEqual({
      name: 'review',
      kind: 'opencode',
      pane_id: 'pane-new',
      args: ['--model', 'current model'],
    });
  });

  test('returns authoritative tab resources and sends arbitrary commands as pane input', async () => {
    const created = tabCreated('pane-command', 'Checks');
    const native = apiClient(request => request.method === 'tab.create'
      ? created
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.createTabAndLaunchCommand('space-1', ' Checks ', '  npm test  ')).resolves.toEqual(created);

    const requests = jest.mocked(native.requestHerdrApi).mock.calls.map(([, request]) => request);
    expect(requests.map(request => request.method)).toEqual([
      'tab.create',
      'pane.send_input',
    ]);
    expect(requests[0].params).toEqual({
      workspace_id: 'space-1',
      label: 'Checks',
      focus: true,
    });
    expect(requests[1].params).toEqual({
      pane_id: 'pane-command',
      text: 'npm test',
      keys: ['enter'],
    });
  });

  test('keeps shell-dependent agent-like commands on pane input', () => {
    expect(classifyAgentCommand('opencode --model "$MODEL"')).toEqual({
      type: 'shell',
      command: 'opencode --model "$MODEL"',
    });
    expect(classifyAgentCommand('opencode && echo done')).toEqual({
      type: 'shell',
      command: 'opencode && echo done',
    });
  });

  test('createTab focuses and returns the created tab and root pane', async () => {
    const created = tabCreated('pane-tab', 'Notes');
    const native = apiClient(() => created);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.createTab('space-1', ' Notes ')).resolves.toEqual(created);
    const request = jest.mocked(native.requestHerdrApi).mock.calls[0][1];
    expect(request).toMatchObject({
      method: 'tab.create',
      params: { workspace_id: 'space-1', label: 'Notes', focus: true },
    });
  });

  test('lets Herdr choose the generated tab name when the run label is blank', async () => {
    const native = apiClient(request => request.method === 'tab.create'
      ? tabCreated('pane-default-name', 'shell')
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.createTabAndLaunchCommand('space-1', '   ', '  npm test  '))
      .resolves.toMatchObject({ root_pane: { pane_id: 'pane-default-name' } });

    const requests = jest.mocked(native.requestHerdrApi).mock.calls.map(([, request]) => request);
    expect(requests.map(request => request.method)).toEqual(['tab.create', 'pane.send_input']);
    expect(requests[0].params).toEqual({ workspace_id: 'space-1', label: null, focus: true });
    expect(requests[1].params).toEqual({
      pane_id: 'pane-default-name',
      text: 'npm test',
      keys: ['enter'],
    });
  });

  test('reports partial success with the created pane when command input fails', async () => {
    const native = apiClient(request => request.method === 'tab.create'
      ? tabCreated('pane-partial', 'Checks')
      : new Error('input transport closed'));
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.createTabAndLaunchCommand('space-1', 'Checks', 'npm test')).rejects.toMatchObject({
      name: 'CommandLaunchPartialFailure',
      message: expect.stringContaining('Tab Checks was created, but command input failed'),
      created: { root_pane: { pane_id: 'pane-partial' } },
    });
    expect(native.requestHerdrApi).toHaveBeenCalledTimes(2);
  });

  test('sends paste events through the pane input API in submission order', async () => {
    const native = apiClient(() => ({ type: 'ok' }));
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await client.pasteIntoPane('pane-1', 'a long paste');
    await client.submitPastesToPane('pane-1', ['please inspect', '/tmp/image.png']);

    const requests = jest.mocked(native.requestHerdrApi).mock.calls.map(([, request]) => request);
    expect(requests.map(request => request.method)).toEqual([
      'pane.send_input',
      'pane.send_input',
      'pane.send_text',
      'pane.send_input',
    ]);
    expect(requests.map(request => request.params)).toEqual([
      { pane_id: 'pane-1', text: 'a long paste', keys: [] },
      { pane_id: 'pane-1', text: 'please inspect', keys: [] },
      { pane_id: 'pane-1', text: ' ' },
      { pane_id: 'pane-1', text: '/tmp/image.png', keys: ['enter'] },
    ]);
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
    let statusChecks = 0;
    const native = apiClient(request => {
      if (request.method === 'ping') {
        statusChecks += 1;
        return statusChecks === 1
          ? new Error('channel is not opened.')
          : { type: 'pong', version: '0.7.4', protocol: 17 };
      }
      return { type: 'session_snapshot', snapshot: { version: '0.7.4', protocol: 17, focused_workspace_id: 'w1', focused_tab_id: 't1', focused_pane_id: 'p1', workspaces: [{ workspace_id: 'w1', number: 1, label: 'work', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 't1', agent_status: 'idle' }], tabs: [], panes: [], layouts: [], agents: [] } };
    });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.snapshot()).resolves.toMatchObject({ server: { running: false }, workspaces: [] });
    await expect(client.snapshot()).resolves.toMatchObject({
      server: { running: true },
      workspaces: [{ workspace_id: 'w1', label: 'work' }],
    });
    expect(statusChecks).toBe(2);
  });

  test('rejects a stale SSH transport instead of reporting an empty Herdr server', async () => {
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

    await expect(client.snapshot()).rejects.toBe('session is down');
    expect(native.getRemoteHome).toHaveBeenCalledTimes(2);
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
