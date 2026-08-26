import SSHClient, { type OpenSSHExecChannelEvent } from 'react-native-whip-ssh';

import { HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => (
  require('./mockWhipSsh').createMockWhipSshModule()
));

const id = '11111111-1111-4111-8111-111111111111';
const profile: ConnectionProfile = {
  id: 'host', name: 'Host', host: 'host.test', port: '22', username: 'me', authMode: 'password',
  secret: 'secret', passphrase: '', herdrCommand: 'herdr', sessionName: 'main',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

describe('HerdrClient Codex transcript transport', () => {
  beforeEach(() => jest.mocked(SSHClient.connectWithPassword).mockReset());

  test('resolves by exact native ID under normal Codex home', async () => {
    const path = `/home/me/.codex/sessions/2026/08/24/rollout-test-${id}.jsonl`;
    const native = {
      getRemoteHome: jest.fn(async () => '/home/me'), execute: jest.fn(async () => `${path}\n`),
      off: jest.fn(), disconnect: jest.fn(),
    } as unknown as SSHClient;
    jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await expect(client.resolveCodexRollout(id)).resolves.toBe(path);
    expect(native.execute).toHaveBeenCalledWith(expect.stringContaining(`rollout-*-${id}.jsonl`));
  });

  test('invalid ID never reaches remote execute', async () => {
    const native = { execute: jest.fn(), off: jest.fn(), disconnect: jest.fn() } as unknown as SSHClient;
    jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await expect(client.resolveCodexRollout(`${id}; uname -a`)).rejects.toThrow('Invalid Codex session ID');
    expect(native.execute).not.toHaveBeenCalled();
  });

  test('opens one persistent exec channel and closes only that channel', async () => {
    let handler: ((event: OpenSSHExecChannelEvent) => void) | null = null;
    const channel = { close: jest.fn(async () => undefined) };
    const native = {
      openExecChannel: jest.fn(async (_command, nextHandler) => { handler = nextHandler; return channel; }),
      off: jest.fn(), disconnect: jest.fn(),
    } as unknown as SSHClient;
    jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    const chunks: ArrayBuffer[] = [];
    const closed = jest.fn();
    const stream = await client.openCodexRolloutStream(`/home/me/.codex/sessions/rollout-${id}.jsonl`, 123, chunk => chunks.push(chunk as ArrayBuffer), closed);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    handler!({ type: 'data', channelId: 'exec-1', bytes });
    handler!({ type: 'closed', channelId: 'exec-1', reason: 'network', closedByClient: false });
    expect(chunks).toEqual([bytes]);
    expect(closed).toHaveBeenCalledWith('network');
    await stream.close();
    expect(channel.close).toHaveBeenCalled();
    expect(native.openExecChannel).toHaveBeenCalledWith(expect.stringContaining("'+124'"), expect.any(Function));
  });

  test('loads the remote byte size used to validate a persisted cursor', async () => {
    const native = {
      execute: jest.fn(async () => '12:34 456\n'), off: jest.fn(), disconnect: jest.fn(),
    } as unknown as SSHClient;
    jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await expect(client.loadCodexRolloutMetadata('/rollout.jsonl')).resolves.toEqual({ fileId: '12:34', size: 456 });
    expect(native.execute).toHaveBeenCalledWith(expect.stringContaining('stat -c'));
  });
});
