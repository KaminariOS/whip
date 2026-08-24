import SSHClient from 'react-native-whip-ssh';

import {
  HerdrClient,
  isTerminalAttachmentUploadCancelled,
} from '../src/services/HerdrClient';
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
    sftpCancelUpload: jest.fn(),
    sftpRm: jest.fn(async () => undefined),
    off: jest.fn(),
    disconnect: jest.fn(),
  };
  return client as unknown as SSHClient;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitForCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await Promise.resolve();
  }
  throw new Error('Expected mock to be called');
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

  test('cancels the active native upload and reports a typed cancellation', async () => {
    const pendingUpload = deferred<void>();
    const native = nativeClient() as SSHClient & {
      sftpCancelUpload: jest.Mock;
      sftpUploadToPath: jest.Mock;
    };
    native.sftpUploadToPath.mockImplementation(() => pendingUpload.promise);
    const client = await connectedClient(native);

    const upload = client.uploadTerminalAttachment('/tmp/image.png');
    await waitForCall(native.sftpUploadToPath);
    client.cancelTerminalAttachmentUpload();

    expect(native.sftpCancelUpload).toHaveBeenCalledTimes(1);
    pendingUpload.reject(new Error('invalid request: SFTP upload cancelled'));
    const error = await upload.catch(reason => reason);
    expect(isTerminalAttachmentUploadCancelled(error)).toBe(true);
  });

  test('cancellation during setup prevents the native upload from starting', async () => {
    const pendingDirectory = deferred<void>();
    const native = nativeClient() as SSHClient & {
      sftpCancelUpload: jest.Mock;
      sftpCreateDirAll: jest.Mock;
      sftpUploadToPath: jest.Mock;
    };
    native.sftpCreateDirAll.mockImplementation(() => pendingDirectory.promise);
    const client = await connectedClient(native);

    const upload = client.uploadTerminalAttachment('/tmp/image.png');
    await waitForCall(native.sftpCreateDirAll);
    client.cancelTerminalAttachmentUpload();

    const error = await upload.catch(reason => reason);
    expect(isTerminalAttachmentUploadCancelled(error)).toBe(true);
    expect(native.sftpCancelUpload).not.toHaveBeenCalled();
    expect(native.sftpUploadToPath).not.toHaveBeenCalled();
    pendingDirectory.resolve();
  });

  test('removes a late successful upload instead of returning its remote path', async () => {
    const pendingUpload = deferred<void>();
    const native = nativeClient() as SSHClient & {
      sftpRm: jest.Mock;
      sftpUploadToPath: jest.Mock;
    };
    native.sftpUploadToPath.mockImplementation(() => pendingUpload.promise);
    const client = await connectedClient(native);

    const upload = client.uploadTerminalAttachment('/tmp/image.png');
    await waitForCall(native.sftpUploadToPath);
    client.cancelTerminalAttachmentUpload();
    pendingUpload.resolve();

    const error = await upload.catch(reason => reason);
    expect(isTerminalAttachmentUploadCancelled(error)).toBe(true);
    expect(native.sftpRm).toHaveBeenCalledWith(
      expect.stringMatching(/^\/home\/whip\/\.whip\/uploads\/image-attachment-.*\.png$/),
    );
  });

  test('clears cancellation state so a subsequent attachment upload succeeds', async () => {
    const firstUpload = deferred<void>();
    const native = nativeClient() as SSHClient & {
      sftpCancelUpload: jest.Mock;
      sftpUploadToPath: jest.Mock;
    };
    native.sftpUploadToPath
      .mockImplementationOnce(() => firstUpload.promise)
      .mockResolvedValueOnce(undefined);
    const client = await connectedClient(native);

    const cancelledUpload = client.uploadTerminalAttachment('/tmp/first.png');
    await waitForCall(native.sftpUploadToPath);
    client.cancelTerminalAttachmentUpload();
    firstUpload.reject(new Error('invalid request: SFTP upload cancelled'));
    expect(isTerminalAttachmentUploadCancelled(await cancelledUpload.catch(reason => reason))).toBe(true);

    await expect(client.uploadTerminalAttachment('/tmp/second.png')).resolves.toMatch(/second-attachment-.*\.png$/);
    expect(native.sftpCancelUpload).toHaveBeenCalledTimes(1);
    expect(native.sftpUploadToPath).toHaveBeenCalledTimes(2);
  });
});
