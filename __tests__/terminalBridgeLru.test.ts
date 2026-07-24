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

function bridgeClient() {
  const requestHerdrApi = jest.fn(async (_socketPath: string, requestLine: string) => {
    const request = JSON.parse(requestLine);
    return JSON.stringify({
      id: request.id,
      result: { type: 'pong', version: '0.7.4', protocol: 17 },
    });
  });
  const native = {
    requestHerdrApi,
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    startHerdrBridge: jest.fn(async () => undefined),
    herdrBridgeResize: jest.fn(async () => undefined),
    closeHerdrBridge: jest.fn(),
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
  return native;
}

describe('terminal bridge channels', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
  });

  test('retains every opened bridge across SSH clients without a maximum', async () => {
    const saviorNative = bridgeClient();
    const oracleNative = bridgeClient();
    connectWithPassword
      .mockResolvedValueOnce(saviorNative)
      .mockResolvedValueOnce(oracleNative);
    const savior = new HerdrClient();
    const oracle = new HerdrClient();
    await savior.connect(profile);
    await oracle.connect({ ...profile, id: 'host-2', host: 'oracle.example.test' });

    for (let index = 1; index <= 8; index += 1) {
      await savior.openTerminal(`savior-${index}`, jest.fn());
      await oracle.openTerminal(`oracle-${index}`, jest.fn());
    }

    expect(saviorNative.closeHerdrBridge).not.toHaveBeenCalled();
    expect(oracleNative.closeHerdrBridge).not.toHaveBeenCalled();
    for (let index = 1; index <= 8; index += 1) {
      expect(savior.isTerminalBridgeRetained(`savior-${index}`)).toBe(true);
      expect(oracle.isTerminalBridgeRetained(`oracle-${index}`)).toBe(true);
    }
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

  test('detaching a WebView controller keeps its SSH bridge warm', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await client.openTerminal('term-1', jest.fn());
    await client.detachTerminal('term-1');

    expect(client.isTerminalBridgeRetained('term-1')).toBe(true);
    expect(native.closeHerdrBridge).not.toHaveBeenCalled();
  });
});
