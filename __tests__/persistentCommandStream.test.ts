import SSHClient from '@dylankenneally/react-native-ssh-sftp';

import { HerdrClient } from '../src/services/HerdrClient';
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
  rememberCredentials: false,
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
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
}

describe('direct Herdr API requests', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
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

  test('reconnects once when the initial SSH transport falsely reports the server offline', async () => {
    const stale = apiClient(() => new Error('channel is not opened.'));
    const fresh = apiClient(request => request.method === 'ping'
      ? { type: 'pong', version: '0.7.4', protocol: 17 }
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
      });
    connectWithPassword.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.initialSnapshot()).resolves.toMatchObject({
      server: { running: true },
      workspaces: [{ workspace_id: 'w1', label: 'work' }],
    });
    expect(connectWithPassword).toHaveBeenCalledTimes(2);
    expect(stale.disconnect).toHaveBeenCalledTimes(1);
  });
});
