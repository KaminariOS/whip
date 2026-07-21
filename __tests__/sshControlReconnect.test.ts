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
  rememberCredentials: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function nativeClient(options: { output?: string; startError?: unknown } = {}) {
  let handler: ((event: { data?: string; closed?: boolean; error?: string }) => void) | null = null;
  const startHerdrCommandStream = jest.fn(async (_command: string, nextHandler: typeof handler) => {
    if (options.startError) throw options.startError;
    handler = nextHandler;
  });
  const writeHerdrCommandStream = jest.fn(async (script: string) => {
    const marker = script.match(/WHIP_COMMAND_[A-Za-z0-9_]+/)?.[0];
    if (!marker || !handler) throw new Error('command stream was not initialized');
    handler({ data: `${options.output ?? '{"result":{}}\n'}\u001e${marker}:0\u001f\n` });
  });
  return {
    startHerdrCommandStream,
    writeHerdrCommandStream,
    closeHerdrCommandStream: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
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
    expect(stale.startHerdrCommandStream).toHaveBeenCalledWith('/bin/sh', expect.any(Function));
    expect(fresh.writeHerdrCommandStream).toHaveBeenCalledWith(
      expect.stringContaining("'herdr' --session 'main' workspace focus 'space-1' 2>&1"),
    );
    expect(stale.disconnect).toHaveBeenCalledTimes(1);
  });

  test('does not replay a mutating command when its channel fails', async () => {
    const stale = nativeClient({ startError: 'channel is not opened.' });
    connectWithPassword.mockResolvedValue(stale);
    const client = new HerdrClient();

    await client.connect(profile);

    await expect(client.createWorkspace('New space', '')).rejects.toBe('channel is not opened.');
    expect(connectWithPassword).toHaveBeenCalledTimes(1);
    expect(stale.startHerdrCommandStream).toHaveBeenCalledTimes(1);
    expect(stale.writeHerdrCommandStream).not.toHaveBeenCalled();
  });
});
