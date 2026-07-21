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

function commandClient(responseFor: (script: string) => string) {
  let handler: ((event: { data?: string; closed?: boolean; error?: string }) => void) | null = null;
  const startHerdrCommandStream = jest.fn(async (_command: string, nextHandler: typeof handler) => {
    handler = nextHandler;
  });
  const writeHerdrCommandStream = jest.fn(async (script: string) => {
    const marker = script.match(/WHIP_COMMAND_[A-Za-z0-9_]+/)?.[0];
    if (!marker || !handler) throw new Error('command stream was not initialized');
    const output = responseFor(script);
    handler({ data: `${output}\u001e${marker}:` });
    handler({ data: '0\u001f\n' });
  });
  return {
    startHerdrCommandStream,
    writeHerdrCommandStream,
    closeHerdrCommandStream: jest.fn(),
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
}

describe('persistent SSH command stream', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
  });

  test('reuses one non-PTY shell for sequential Herdr commands', async () => {
    const native = commandClient(() => '{"result":{}}\n');
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await client.focusWorkspace('space-1');
    await client.focusTab('tab-1');

    expect(native.startHerdrCommandStream).toHaveBeenCalledTimes(1);
    expect(native.startHerdrCommandStream).toHaveBeenCalledWith('/bin/sh', expect.any(Function));
    expect(native.writeHerdrCommandStream).toHaveBeenCalledTimes(2);
    expect(native.writeHerdrCommandStream).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("workspace focus 'space-1'"),
    );
    expect(native.writeHerdrCommandStream).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("tab focus 'tab-1'"),
    );
  });

  test('serializes concurrent commands and preserves multiline UTF-8 output', async () => {
    const native = commandClient(script => script.includes('pane read')
      ? '{"result":{"read":{"text":"first\\n你好"}}}\n'
      : '{"result":{}}\n');
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    const [read] = await Promise.all([
      client.readPane('pane-1'),
      client.focusPane('pane-1'),
    ]);

    expect(read).toBe('first\n你好');
    expect(native.startHerdrCommandStream).toHaveBeenCalledTimes(1);
    expect(native.writeHerdrCommandStream).toHaveBeenCalledTimes(2);
  });

  test('rejects an in-flight command when the persistent stream closes', async () => {
    let handler: ((event: { closed?: boolean; error?: string }) => void) | null = null;
    const native = {
      startHerdrCommandStream: jest.fn(async (_command: string, nextHandler: typeof handler) => {
        handler = nextHandler;
      }),
      writeHerdrCommandStream: jest.fn(async () => {
        handler?.({ closed: true, error: 'socket is not established' });
      }),
      closeHerdrCommandStream: jest.fn(),
      off: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as SSHClient;
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await expect(client.createWorkspace('space', '')).rejects.toBe('socket is not established');
  });
});
