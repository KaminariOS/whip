import AsyncStorage from '@react-native-async-storage/async-storage';
import SSHClient from 'react-native-whip-ssh';
import {
  KNOWN_HOSTS_STORAGE_KEY,
  KnownHostsUnavailableError,
  deleteKnownHost,
  hostKeyErrorHost,
  knownHostsFromStorage,
  loadKnownHosts,
  parseKnownHosts,
  parseUnknownHostKey,
  trustKnownHost,
  type KnownHostsLoadState,
  type UnknownHostKeyChallenge,
} from '../src/services/knownHosts';
import type { KnownHost } from '../src/types';

let mockStoredKnownHosts: string | null = null;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(mockStoredKnownHosts)),
    setItem: jest.fn((_key: string, value: string) => {
      mockStoredKnownHosts = value;
      return Promise.resolve();
    }),
  },
}));

jest.mock('react-native-whip-ssh', () => ({
  __esModule: true,
  default: {
    setTrustedHostKeys: jest.fn(),
  },
}));

const knownHost: KnownHost = {
  id: 'known-host-1',
  host: 'savior.tailnet.ts.net',
  port: 22,
  keyType: 'ssh-ed25519',
  publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAITest',
  fingerprint: 'SHA256:abc123',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const challenge = (
  host: string,
  fingerprint: string,
): UnknownHostKeyChallenge => ({
  host,
  port: 22,
  keyType: 'ssh-ed25519',
  publicKey: `AAAA-${host}`,
  fingerprint,
});

function loadedHosts(state: KnownHostsLoadState): KnownHost[] {
  expect(state.status).toBe('loaded');
  if (state.status !== 'loaded') throw new Error('Expected loaded known hosts');
  return state.hosts;
}

beforeEach(() => {
  mockStoredKnownHosts = null;
  jest.clearAllMocks();
  knownHostsFromStorage(null);
  jest.clearAllMocks();
});

test('loads a missing store as authoritative empty and permits the first host', async () => {
  const state = await loadKnownHosts();

  expect(loadedHosts(state)).toEqual([]);
  expect(SSHClient.setTrustedHostKeys).toHaveBeenCalledWith([]);

  const next = await trustKnownHost(challenge('first.example', 'SHA256:first'));
  expect(next).toHaveLength(1);
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    KNOWN_HOSTS_STORAGE_KEY,
    expect.any(String),
  );
});

test('loads a valid global list into the native strict host-key repository', async () => {
  mockStoredKnownHosts = JSON.stringify([knownHost]);

  const state = await loadKnownHosts();

  expect(loadedHosts(state)).toEqual([knownHost]);
  expect(SSHClient.setTrustedHostKeys).toHaveBeenCalledWith([{
    host: 'savior.tailnet.ts.net',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAITest',
  }]);
});

test('read failure is explicit and preserves the native trust repository', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('read unavailable');
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(error);

  const state = await loadKnownHosts();

  expect(state).toEqual({ status: 'failed', error });
  expect(SSHClient.setTrustedHostKeys).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '"fallbackUsed":"preserved-native-known-hosts"',
  ));
  consoleError.mockRestore();
});

test('malformed JSON fails without exposing key material or clearing native trust', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  const state = knownHostsFromStorage('{AAAASensitiveKey');

  expect(state.status).toBe('failed');
  expect(SSHClient.setTrustedHostKeys).not.toHaveBeenCalled();
  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-parse-failed');
  expect(diagnostic).not.toContain('AAAASensitiveKey');
  consoleError.mockRestore();
});

test('non-array persisted JSON fails closed', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  expect(knownHostsFromStorage(JSON.stringify({ hosts: [knownHost] })).status)
    .toBe('failed');
  expect(SSHClient.setTrustedHostKeys).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

test('one malformed element rejects the entire persisted list', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const malformed = { ...knownHost, id: '' };

  const state = knownHostsFromStorage(JSON.stringify([knownHost, malformed]));

  expect(state.status).toBe('failed');
  expect(SSHClient.setTrustedHostKeys).not.toHaveBeenCalled();
  expect(() => parseKnownHosts(JSON.stringify([knownHost, malformed])))
    .toThrow('index 1');
  consoleError.mockRestore();
});

test('failed hydration cannot clobber a durable list with a new trust decision', async () => {
  const durableHosts = [
    knownHost,
    { ...knownHost, id: 'known-host-2', host: 'b.example' },
    { ...knownHost, id: 'known-host-3', host: 'c.example' },
  ];
  mockStoredKnownHosts = JSON.stringify(durableHosts);
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('temporary failure'));
  expect((await loadKnownHosts()).status).toBe('failed');
  jest.clearAllMocks();

  await expect(trustKnownHost(challenge('d.example', 'SHA256:d')))
    .rejects.toBeInstanceOf(KnownHostsUnavailableError);

  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(mockStoredKnownHosts).toBe(JSON.stringify(durableHosts));
  consoleError.mockRestore();
});

test('stores a confirmed host globally with structured nonstandard-port data', async () => {
  const next = await trustKnownHost({
    ...challenge('Thinker.Example', 'SHA256:new'),
    port: 2222,
    publicKey: 'AAAANewKey',
  });

  expect(next[0]).toMatchObject({
    host: 'Thinker.Example',
    port: 2222,
    keyType: 'ssh-ed25519',
  });
  expect(next[0].id).toMatch(/^known-host-/);
  expect(SSHClient.setTrustedHostKeys).toHaveBeenLastCalledWith([{
    host: 'Thinker.Example',
    port: 2222,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAANewKey',
  }]);
});

test('persists native-produced OpenSSH public-key syntax unchanged', async () => {
  const next = await trustKnownHost({
    ...challenge('Mini', 'SHA256:ios'),
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
  });

  expect(next[0].publicKey).toBe('ssh-ed25519 AAAAIosKey mini');
});

test('deduplicates trusted challenges by host, port, type, and fingerprint', async () => {
  const legacyHost = {
    ...knownHost,
    host: 'mini',
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
  };
  mockStoredKnownHosts = JSON.stringify([legacyHost]);
  knownHostsFromStorage(mockStoredKnownHosts);
  jest.clearAllMocks();

  const next = await trustKnownHost({
    host: 'mini',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: legacyHost.publicKey,
    fingerprint: legacyHost.fingerprint,
  });

  expect(next).toEqual([legacyHost]);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(SSHClient.setTrustedHostKeys).not.toHaveBeenCalled();
});

test('does not persist trusted host material rejected by Rust validation', async () => {
  jest.mocked(SSHClient.setTrustedHostKeys).mockImplementationOnce(() => {
    throw new Error('trusted host key is malformed');
  });

  await expect(trustKnownHost({
    ...challenge('invalid.example', 'SHA256:invalid'),
    publicKey: 'not-base64',
  })).rejects.toThrow('malformed');

  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

test('write failure restores native and application-visible state', async () => {
  mockStoredKnownHosts = JSON.stringify([knownHost]);
  knownHostsFromStorage(mockStoredKnownHosts);
  jest.clearAllMocks();
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('write unavailable');
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(error);

  await expect(deleteKnownHost(knownHost.id)).rejects.toBe(error);

  expect(mockStoredKnownHosts).toBe(JSON.stringify([knownHost]));
  expect(SSHClient.setTrustedHostKeys).toHaveBeenLastCalledWith([{
    host: knownHost.host,
    port: knownHost.port,
    keyType: knownHost.keyType,
    publicKey: knownHost.publicKey,
  }]);

  const recovered = await trustKnownHost(challenge('next.example', 'SHA256:next'));
  expect(recovered).toEqual(expect.arrayContaining([knownHost]));
  expect(recovered).toHaveLength(2);
  expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(knownHost.publicKey);
  consoleError.mockRestore();
});

test('serializes overlapping trust and delete mutations without losing updates', async () => {
  mockStoredKnownHosts = JSON.stringify([knownHost]);
  knownHostsFromStorage(mockStoredKnownHosts);
  jest.clearAllMocks();

  await Promise.all([
    trustKnownHost(challenge('b.example', 'SHA256:b')),
    trustKnownHost(challenge('c.example', 'SHA256:c')),
    deleteKnownHost(knownHost.id),
  ]);

  const persisted = parseKnownHosts(mockStoredKnownHosts);
  expect(persisted.map(host => host.host)).toEqual(['b.example', 'c.example']);
  expect(SSHClient.setTrustedHostKeys).toHaveBeenLastCalledWith([
    expect.objectContaining({ host: 'b.example' }),
    expect.objectContaining({ host: 'c.example' }),
  ]);
});

test('parses structured native host-key errors without weakening changed-key behavior', () => {
  expect(parseUnknownHostKey({
    code: 'HOST_KEY_UNKNOWN',
    message: 'unknown SSH host key',
    details: {
      host: 'Savior',
      port: 22,
      keyType: 'ssh-ed25519',
      publicKey: 'AAAA',
      fingerprint: 'SHA256:key',
    },
  })).toEqual({
    host: 'Savior',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAA',
    fingerprint: 'SHA256:key',
  });
  expect(parseUnknownHostKey('HostKey has been changed')).toBeNull();
  expect(hostKeyErrorHost({
    code: 'HOST_KEY_CHANGED',
    details: { host: 'Jump.Example', port: 2222 },
  })).toBe('[Jump.Example]:2222');
});
