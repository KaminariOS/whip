import { errorCode } from '../src/lib/connectionErrors';
import { HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

const mockWhipSsh = require('./mockWhipSsh').getMockWhipSshControl();
const connectWithPassword: jest.Mock = mockWhipSsh.connectWithPassword;

const profile: ConnectionProfile = {
  id: 'host-1', name: 'Test host', host: 'host.example.test', port: '22', username: 'whip',
  authMode: 'password', secret: 'secret', passphrase: '', herdrCommand: 'herdr', sessionName: 'main',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function nativeClient(upload?: () => Promise<void>) {
  return {
    getRemoteHome: jest.fn(async () => '/home/whip'),
    sftpCreateDirAll: jest.fn(async () => undefined),
    sftpUploadToPath: jest.fn(upload || (async () => undefined)),
    sftpCancelUpload: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  };
}

async function connectedClient(native: ReturnType<typeof nativeClient>): Promise<HerdrClient> {
  connectWithPassword.mockResolvedValueOnce(native);
  const client = new HerdrClient();
  await client.connect(profile);
  return client;
}

describe('terminal attachment uploads', () => {
  beforeEach(() => connectWithPassword.mockReset());

  it('asks HostRuntime for a product-level transfer and returns its remote path', async () => {
    const native = nativeClient();
    const client = await connectedClient(native);

    const transfer = client.native.startAttachmentUpload('/tmp/Screen shot (final).PNG');
    const result = await transfer.result;

    expect(native.sftpCreateDirAll).toHaveBeenCalledWith('/home/whip/.whip/uploads');
    expect(native.sftpUploadToPath).toHaveBeenCalledWith('/tmp/Screen shot (final).PNG', result.remotePath);
    expect(result.remotePath).toMatch(/^\/home\/whip\/\.whip\/uploads\/Screen-shot-final-transfer-\d+\.PNG$/);
  });

  it('propagates native transfer failures', async () => {
    const client = await connectedClient(nativeClient(async () => { throw new Error('disk full'); }));
    await expect(client.native.startAttachmentUpload('/tmp/image.png').result).rejects.toThrow('disk full');
  });

  it('cancels by stable transfer ID', async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const native = nativeClient(() => pending);
    const client = await connectedClient(native);
    const transfer = client.native.startAttachmentUpload('/tmp/image.png');

    expect(client.native.cancelTransfer(transfer.id)).toBe(true);
    expect(native.sftpCancelUpload).toHaveBeenCalledTimes(1);
    reject(Object.assign(new Error('transfer cancelled'), { code: 'TRANSFER_CANCELLED' }));
    expect(errorCode(await transfer.result.catch((error: unknown) => error))).toBe('TRANSFER_CANCELLED');
  });
});
