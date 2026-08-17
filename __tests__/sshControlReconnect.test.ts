import SSHClient from '@dylankenneally/react-native-ssh-sftp';

import { HerdrClient, isUnavailableSshChannel } from '../src/services/HerdrClient';
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

function nativeClient(options: { output?: string; startError?: unknown } = {}) {
  const requestHerdrApi = jest.fn(async (_socketPath: string, requestLine: string) => {
    if (options.startError) throw options.startError;
    const request = JSON.parse(requestLine);
    return options.output ?? JSON.stringify({ id: request.id, result: { type: 'ok' } });
  });
  return {
    requestHerdrApi,
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
}

function streamingNativeClient() {
  let eventHandler: ((data: string) => void) | null = null;
  const client = {
    requestHerdrApi: jest.fn(async (_socketPath: string, requestLine: string) => {
      const request = JSON.parse(requestLine);
      const result = request.method === 'session.snapshot'
        ? {
          type: 'session_snapshot',
          snapshot: {
            version: '0.8.0',
            protocol: 20,
            focused_workspace_id: null,
            focused_tab_id: null,
            focused_pane_id: null,
            workspaces: [],
            tabs: [],
            panes: [],
            layouts: [],
            agents: [],
          },
        }
        : request.method === 'ping'
          ? { type: 'pong', version: '0.8.0', protocol: 20 }
          : { type: 'ok' };
      return JSON.stringify({ id: request.id, result });
    }),
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    startHerdrEventStream: jest.fn(async (_socketPath: string, handler: (data: string) => void) => {
      eventHandler = handler;
    }),
    writeHerdrEventStream: jest.fn(async () => undefined),
    closeHerdrEventStream: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
  return {
    client,
    emitEventData: (data: string) => eventHandler?.(data),
  };
}

describe('SSH control reconnects', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
  });

  test.each([
    'channel not open',
    'channel is not opened.',
    new Error('session is down'),
    new Error('socket is not established'),
  ])('classifies unavailable transport errors: %s', error => {
    expect(isUnavailableSshChannel(error)).toBe(true);
  });

  test('does not classify Herdr command errors as transport failures', () => {
    expect(isUnavailableSshChannel(new Error('workspace not found'))).toBe(false);
  });

  test('reconnects once and retries an idempotent workspace focus', async () => {
    const stale = nativeClient({ startError: 'channel is not opened.' });
    const fresh = nativeClient();
    connectWithPassword.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    const client = new HerdrClient();

    await client.connect(profile);
    await client.focusWorkspace('space-1');

    expect(connectWithPassword).toHaveBeenCalledTimes(2);
    expect(stale.requestHerdrApi).toHaveBeenCalledTimes(1);
    expect(fresh.requestHerdrApi).toHaveBeenCalledWith(
      '/home/herdr/.config/herdr/sessions/main/herdr.sock',
      expect.stringContaining('"method":"workspace.focus"'),
    );
    expect(stale.disconnect).toHaveBeenCalledTimes(1);
  });

  test('restores the event subscription when replacing the control connection', async () => {
    const stale = streamingNativeClient();
    const fresh = streamingNativeClient();
    connectWithPassword.mockResolvedValueOnce(stale.client).mockResolvedValueOnce(fresh.client);
    const client = new HerdrClient();
    const onEvent = jest.fn();
    const onClosed = jest.fn();

    await client.connect(profile);
    await client.initialSnapshot();
    await client.openEventStream(['pane-2', 'pane-1'], onEvent, onClosed);
    await client.reconnectControl();

    expect(stale.client.closeHerdrEventStream).toHaveBeenCalled();
    expect(stale.client.disconnect).toHaveBeenCalledTimes(1);
    expect(fresh.client.startHerdrEventStream).toHaveBeenCalledTimes(1);
    expect(fresh.client.writeHerdrEventStream).toHaveBeenCalledWith(
      expect.stringContaining('"method":"events.subscribe"'),
    );

    stale.emitEventData('{"herdr_android_bridge_closed":true}\n');
    expect(onClosed).not.toHaveBeenCalled();

    fresh.emitEventData('{"event":"pane.agent_status_changed","data":{"pane_id":"pane-1"}}\n');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pane.agent_status_changed',
      data: { pane_id: 'pane-1' },
    }));
  });

  test('does not replay a mutating command when its channel fails', async () => {
    const stale = nativeClient({ startError: 'channel is not opened.' });
    connectWithPassword.mockResolvedValue(stale);
    const client = new HerdrClient();

    await client.connect(profile);

    await expect(client.createWorkspace('New space', '')).rejects.toBe('channel is not opened.');
    expect(connectWithPassword).toHaveBeenCalledTimes(1);
    expect(stale.requestHerdrApi).toHaveBeenCalledTimes(1);
  });
});
