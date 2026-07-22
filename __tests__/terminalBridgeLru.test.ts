import SSHClient from '@dylankenneally/react-native-ssh-sftp';

import {
  HerdrClient,
  MAX_RETAINED_TERMINAL_BRIDGES,
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
  rememberCredentials: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bridgeClient() {
  let commandHandler: ((event: { data?: string }) => void) | null = null;
  const startHerdrCommandStream = jest.fn(async (_command: string, handler: typeof commandHandler) => {
    commandHandler = handler;
  });
  const writeHerdrCommandStream = jest.fn(async (script: string) => {
    const marker = script.match(/WHIP_COMMAND_[A-Za-z0-9_]+/)?.[0];
    if (!marker || !commandHandler) throw new Error('command stream was not initialized');
    commandHandler({
      data: `{"running":true,"protocol":17,"compatible":true,"socket":"/tmp/herdr.sock"}\n\u001e${marker}:0\u001f\n`,
    });
  });
  const native = {
    startHerdrCommandStream,
    writeHerdrCommandStream,
    startHerdrBridge: jest.fn(async () => undefined),
    herdrBridgeResize: jest.fn(async () => undefined),
    closeHerdrBridge: jest.fn(),
    closeHerdrCommandStream: jest.fn(),
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
  return native;
}

describe('terminal bridge LRU', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
  });

  test('retains three bridges and evicts the least recently focused terminal', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await client.openTerminal('term-1', jest.fn());
    await client.openTerminal('term-2', jest.fn());
    await client.openTerminal('term-3', jest.fn());
    await client.openTerminal('term-1', jest.fn());
    await client.openTerminal('term-4', jest.fn());

    expect(MAX_RETAINED_TERMINAL_BRIDGES).toBe(3);
    expect(native.startHerdrBridge).toHaveBeenCalledTimes(4);
    expect(native.closeHerdrBridge).toHaveBeenCalledWith('term-2');
    expect(client.isTerminalBridgeRetained('term-1')).toBe(true);
    expect(client.isTerminalBridgeRetained('term-2')).toBe(false);
    expect(client.isTerminalBridgeRetained('term-3')).toBe(true);
    expect(client.isTerminalBridgeRetained('term-4')).toBe(true);
  });

  test('explicit release removes a retained bridge immediately', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await client.openTerminal('term-1', jest.fn());
    await client.releaseTerminal('term-1');

    expect(client.isTerminalBridgeRetained('term-1')).toBe(false);
    expect(native.closeHerdrBridge).toHaveBeenCalledWith('term-1');
  });
});
