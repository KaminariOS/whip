import SSHClient from 'react-native-whip-ssh';

import { HerdrClient } from '../src/services/HerdrClient';
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
  username: 'whip',
  authMode: 'password',
  secret: 'secret',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: 'main',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function nativeClient(options: { uploadError?: Error } = {}) {
  const client = {
    getRemoteHome: jest.fn(async () => '/home/whip'),
    sftpCreateDirAll: jest.fn(async () => undefined),
    sftpUploadToPath: options.uploadError
      ? jest.fn(async () => { throw options.uploadError; })
      : jest.fn(async () => undefined),
    off: jest.fn(),
    disconnect: jest.fn(),
  };
  return client as unknown as SSHClient;
}

async function connectedClient(native: SSHClient): Promise<HerdrClient> {
  connectWithPassword.mockResolvedValueOnce(native);
  const client = new HerdrClient();
  await client.connect(profile);
  return client;
}

describe('terminal attachment uploads', () => {
  beforeEach(() => connectWithPassword.mockReset());

  test('creates the upload tree and uploads directly to an exact unique path', async () => {
    const native = nativeClient() as SSHClient & {
      sftpCreateDirAll: jest.Mock;
      sftpUploadToPath: jest.Mock;
    };
    const client = await connectedClient(native);

    const remotePath = await client.uploadTerminalAttachment('/tmp/Screen shot (final).PNG');

    expect(native.sftpCreateDirAll).toHaveBeenCalledWith('/home/whip/.whip/uploads');
    expect(native.sftpUploadToPath).toHaveBeenCalledWith('/tmp/Screen shot (final).PNG', remotePath);
    expect(remotePath).toMatch(/^\/home\/whip\/\.whip\/uploads\/Screen-shot-final-attachment-.*\.PNG$/);
  });

  test('does not collide when uploading duplicate local basenames', async () => {
    const native = nativeClient();
    const client = await connectedClient(native);

    const first = await client.uploadTerminalAttachment('/cache/one/duplicate.png');
    const second = await client.uploadTerminalAttachment('/cache/two/duplicate.png');

    expect(first).not.toBe(second);
    expect(first).toMatch(/\.png$/);
    expect(second).toMatch(/\.png$/);
  });

  test('propagates exact-path upload errors', async () => {
    const native = nativeClient({ uploadError: new Error('disk full') }) as SSHClient & {
      sftpUploadToPath: jest.Mock;
    };
    const client = await connectedClient(native);

    await expect(client.uploadTerminalAttachment('/tmp/image.png')).rejects.toThrow('disk full');
    expect(native.sftpUploadToPath).toHaveBeenCalledWith(
      '/tmp/image.png',
      expect.stringMatching(/^\/home\/whip\/\.whip\/uploads\/image-attachment-.*\.png$/),
    );
  });
});
