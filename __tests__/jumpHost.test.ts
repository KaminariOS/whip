import SSHClient from 'react-native-whip-ssh';

import { HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({
  __esModule: true,
  default: {
    connectWithPassword: jest.fn(),
    connectWithPasswordViaJump: jest.fn(),
    connectWithKey: jest.fn(),
    connectWithKeyViaJump: jest.fn(),
  },
}));

const connectWithPassword = jest.mocked(SSHClient.connectWithPassword);
const connectWithPasswordViaJump = jest.mocked(SSHClient.connectWithPasswordViaJump);
const connectWithKey = jest.mocked(SSHClient.connectWithKey);

function profile(
  id: string,
  host: string,
  port = '22',
): ConnectionProfile {
  return {
    id,
    name: id,
    host,
    port,
    username: `${id}-user`,
    authMode: 'password',
    secret: `${id}-password`,
    passphrase: '',
    herdrCommand: 'herdr',
    sessionName: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function nativeClient() {
  return {
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
    setAgentForwarding: jest.fn(),
  } as unknown as SSHClient;
}

describe('SSH jump hosts', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
    connectWithPasswordViaJump.mockReset();
    connectWithKey.mockReset();
  });

  it('connects a nested ProxyJump chain from the outermost host to the destination', async () => {
    const outerProfile = profile('outer', 'outer.example.test');
    const innerProfile = profile('inner', 'inner.internal', '2200');
    const targetProfile = profile('target', 'target.internal');
    const outer = nativeClient();
    const inner = nativeClient();
    const target = nativeClient();
    connectWithPassword.mockResolvedValueOnce(outer);
    connectWithPasswordViaJump
      .mockResolvedValueOnce(inner)
      .mockResolvedValueOnce(target);
    const client = new HerdrClient();

    await client.connect(targetProfile, [outerProfile, innerProfile]);

    expect(connectWithPassword).toHaveBeenNthCalledWith(
      1,
      'outer.example.test',
      22,
      'outer-user',
      'outer-password',
    );
    expect(connectWithPasswordViaJump).toHaveBeenNthCalledWith(
      1,
      'inner.internal',
      2200,
      'inner-user',
      'inner-password',
      outer,
    );
    expect(connectWithPasswordViaJump).toHaveBeenNthCalledWith(
      2,
      'target.internal',
      22,
      'target-user',
      'target-password',
      inner,
    );

    client.disconnect();

    expect(target.disconnect).toHaveBeenCalledTimes(1);
    expect(inner.disconnect).toHaveBeenCalledTimes(1);
    expect(outer.disconnect).toHaveBeenCalledTimes(1);
    expect(jest.mocked(inner.disconnect).mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(outer.disconnect).mock.invocationCallOrder[0]);
  });

  it('closes connected proxies when a later hop fails', async () => {
    const outer = nativeClient();
    connectWithPassword.mockResolvedValueOnce(outer);
    connectWithPasswordViaJump.mockRejectedValueOnce(new Error('jump authentication failed'));
    const client = new HerdrClient();

    await expect(client.connect(
      profile('target', 'target.internal'),
      [profile('outer', 'outer.example.test'), profile('inner', 'inner.internal')],
    )).rejects.toThrow('jump authentication failed');

    expect(outer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('enables agent forwarding on an opted-in private-key host', async () => {
    const target = nativeClient();
    connectWithKey.mockResolvedValueOnce(target);
    const targetProfile: ConnectionProfile = {
      ...profile('target', 'target.example.test'),
      authMode: 'key',
      secret: 'private-key',
      forwardAgent: true,
    };
    const client = new HerdrClient();

    await client.connect(targetProfile);

    expect(connectWithKey).toHaveBeenCalledWith(
      'target.example.test',
      22,
      'target-user',
      'private-key',
      undefined,
    );
    expect(target.setAgentForwarding).toHaveBeenCalledWith(true);
  });

});
