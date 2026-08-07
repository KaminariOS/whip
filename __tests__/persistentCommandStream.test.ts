import SSHClient from '@dylankenneally/react-native-ssh-sftp';

import {
  clearHerdrSocketPathCache,
  HerdrClient,
} from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('@dylankenneally/react-native-ssh-sftp', () => ({
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

function apiClient(responseFor: (request: { method: string; params: Record<string, unknown> }) => unknown) {
  const requestHerdrApi = jest.fn(async (_socketPath: string, line: string) => {
    const request = JSON.parse(line);
    const result = responseFor(request);
    if (result instanceof Error) throw result.message;
    return JSON.stringify({ id: request.id, result });
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
      expect.stringContaining('"method":"workspace.focus"'),
    );
    expect(native.requestHerdrApi).toHaveBeenNthCalledWith(
      2,
      '/home/herdr/.config/herdr/sessions/main/herdr.sock',
      expect.stringContaining('"method":"tab.focus"'),
    );
  });

  test('uses the versioned session snapshot as the initial availability probe', async () => {
    const native = apiClient(() => ({
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
    }));
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.initialSnapshot()).resolves.toMatchObject({
      server: { running: true },
    });

    const methods = jest.mocked(native.requestHerdrApi).mock.calls
      .map(([, line]) => JSON.parse(line).method);
    expect(methods).toEqual(['session.snapshot']);
  });

  test('measures device-to-host latency instead of a session snapshot', async () => {
    const native = apiClient(request => request.method === 'ping'
      ? { type: 'pong' }
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await expect(client.measureLatency()).resolves.toBe(42);

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
      writeHerdrEventStream: jest.fn(async () => undefined),
      closeHerdrEventStream: jest.fn(),
    });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await client.initialSnapshot();
    await client.openEventStream([], jest.fn());
    jest.mocked(native.measureHostLatency).mockResolvedValueOnce(37);

    await expect(client.measureLatency()).resolves.toBe(37);

    const directMethods = jest.mocked(native.requestHerdrApi).mock.calls
      .map(([, line]) => JSON.parse(line).method);
    expect(directMethods).toEqual(['session.snapshot']);
    expect(native.measureHostLatency).toHaveBeenCalledTimes(1);
    expect(native.writeHerdrEventStream).toHaveBeenCalledTimes(1);
  });

  test('starts an agent in a new tab in the selected workspace', async () => {
    const native = apiClient(request => request.method === 'tab.create'
      ? { type: 'tab_created', root_pane: { pane_id: 'pane-new' } }
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await client.startAgent('space-1', ' Codex ', ' codex ');

    const requests = jest.mocked(native.requestHerdrApi).mock.calls.map(([, line]) => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual([
      'tab.create',
      'pane.rename',
      'pane.send_input',
    ]);
    expect(requests[0].params).toEqual({
      workspace_id: 'space-1',
      label: 'Codex',
      focus: true,
    });
    expect(requests[1].params).toEqual({ pane_id: 'pane-new', label: 'Codex' });
    expect(requests[2].params).toEqual({
      pane_id: 'pane-new',
      text: 'codex',
      keys: ['Enter'],
    });
  });

  test('runs an arbitrary command in a new command tab', async () => {
    const native = apiClient(request => request.method === 'tab.create'
      ? { type: 'tab_created', root_pane: { pane_id: 'pane-command' } }
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.runCommand('space-1', '  npm test  ')).resolves.toBe('pane-command');

    const requests = jest.mocked(native.requestHerdrApi).mock.calls.map(([, line]) => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual([
      'tab.create',
      'pane.rename',
      'pane.send_input',
    ]);
    expect(requests[0].params).toEqual({
      workspace_id: 'space-1',
      label: 'command',
      focus: true,
    });
    expect(requests[1].params).toEqual({ pane_id: 'pane-command', label: 'command' });
    expect(requests[2].params).toEqual({
      pane_id: 'pane-command',
      text: 'npm test',
      keys: ['Enter'],
    });
  });

  test('serializes concurrent commands and preserves multiline UTF-8 output', async () => {
    const native = apiClient(request => request.method === 'pane.read'
      ? { type: 'pane_read', read: { text: 'first\n你好' } }
      : { type: 'ok' });
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    const [read] = await Promise.all([
      client.readPane('pane-1'),
      client.focusPane('pane-1'),
    ]);

    expect(read).toBe('first\n你好');
    expect(native.requestHerdrApi).toHaveBeenCalledTimes(2);
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
      expect.stringContaining('"method":"session.snapshot"'),
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
      requestHerdrApi: jest.fn(async (socketPath: string, line: string) => {
        if (socketPath.startsWith('/home/herdr/')) throw 'channel is not opened.';
        const request = JSON.parse(line);
        return JSON.stringify({ id: request.id, result: snapshot });
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
      expect.stringContaining('"method":"session.snapshot"'),
    );
  });
});
