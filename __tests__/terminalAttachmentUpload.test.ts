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

function sftpEntry(filename: string) {
  return {
    filename,
    isDirectory: false,
    modificationDate: '0',
    lastAccess: '0',
    fileSize: 123,
    ownerUserID: 0,
    ownerGroupID: 0,
    flags: 0,
  };
}

function nativeClient(options: { uploadError?: Error; verify?: boolean } = {}) {
  let promotedFilename = '';
  const client = {
    getRemoteHome: jest.fn(async () => '/home/whip'),
    sftpMkdir: jest.fn(async () => undefined),
    sftpLs: jest.fn(async (path: string) => (
      path === '/home/whip/.whip/uploads' && options.verify !== false && promotedFilename
        ? [sftpEntry(promotedFilename)]
        : []
    )),
    sftpUpload: options.uploadError
      ? jest.fn(async () => { throw options.uploadError; })
      : jest.fn(async () => undefined),
    sftpRename: jest.fn(async (_from: string, to: string) => {
      promotedFilename = to.split('/').pop() || '';
    }),
    sftpRm: jest.fn(async () => undefined),
    sftpRmdir: jest.fn(async () => undefined),
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

  test('stages through the directory API, promotes to an exact unique path, and verifies it', async () => {
    const native = nativeClient() as SSHClient & {
      sftpUpload: jest.Mock;
      sftpRename: jest.Mock;
      sftpLs: jest.Mock;
      sftpRmdir: jest.Mock;
    };
    const client = await connectedClient(native);

    const remotePath = await client.uploadTerminalAttachment('/tmp/Screen shot (final).PNG');
    const stagingDirectory = native.sftpUpload.mock.calls[0][1];

    expect(stagingDirectory).toMatch(/^\/home\/whip\/\.whip\/uploads\/\.attachment-.*\.upload$/);
    expect(native.sftpUpload).toHaveBeenCalledWith('/tmp/Screen shot (final).PNG', stagingDirectory);
    expect(native.sftpRename).toHaveBeenCalledWith(
      `${stagingDirectory}/Screen shot (final).PNG`,
      remotePath,
    );
    expect(remotePath).toMatch(/^\/home\/whip\/\.whip\/uploads\/Screen-shot-final-attachment-.*\.PNG$/);
    expect(native.sftpLs).toHaveBeenLastCalledWith('/home/whip/.whip/uploads');
    expect(native.sftpRmdir).toHaveBeenCalledWith(stagingDirectory);
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

  test('rejects and removes the promoted file when exact-path verification fails', async () => {
    const native = nativeClient({ verify: false }) as SSHClient & {
      sftpRename: jest.Mock;
      sftpRm: jest.Mock;
      sftpRmdir: jest.Mock;
    };
    const client = await connectedClient(native);

    await expect(client.uploadTerminalAttachment('/tmp/image.png')).rejects.toThrow(
      /was not found at \/home\/whip\/\.whip\/uploads\//,
    );
    const remotePath = native.sftpRename.mock.calls[0][1];
    expect(native.sftpRm).toHaveBeenCalledWith(remotePath);
    expect(native.sftpRmdir).toHaveBeenCalledTimes(1);
  });

  test('propagates upload errors and cleans the staging directory', async () => {
    const native = nativeClient({ uploadError: new Error('disk full') }) as SSHClient & {
      sftpRm: jest.Mock;
      sftpRmdir: jest.Mock;
    };
    const client = await connectedClient(native);

    await expect(client.uploadTerminalAttachment('/tmp/image.png')).rejects.toThrow('disk full');
    expect(native.sftpRm).toHaveBeenCalledWith(expect.stringMatching(/\.upload\/image\.png$/));
    expect(native.sftpRmdir).toHaveBeenCalledTimes(1);
  });
});
