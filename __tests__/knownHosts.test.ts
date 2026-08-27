import AsyncStorage from '@react-native-async-storage/async-storage';
import SSHClient from 'react-native-whip-ssh';
import {
  KNOWN_HOSTS_STORAGE_KEY,
  deleteKnownHost,
  hostKeyErrorHost,
  knownHostsFromStorage,
  loadKnownHosts,
  parseUnknownHostKey,
  trustKnownHost,
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

beforeEach(() => {
  mockStoredKnownHosts = null;
  jest.clearAllMocks();
});

test('loads the global list into the native strict host-key repository', async () => {
  mockStoredKnownHosts = JSON.stringify([knownHost]);

  await expect(loadKnownHosts()).resolves.toEqual([knownHost]);
  expect(SSHClient.setTrustedHostKeys).toHaveBeenCalledWith([{
    host: 'savior.tailnet.ts.net',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAITest',
  }]);
});

test('logs known-host read rejection without changing rejection behavior', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('read unavailable');
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(error);

  await expect(loadKnownHosts()).rejects.toBe(error);

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-read-failed',
  ));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '"store":"known-hosts"',
  ));
  consoleError.mockRestore();
});

test('logs malformed known-host JSON without exposing key material', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  expect(knownHostsFromStorage('{AAAASensitiveKey')).toEqual([]);

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-parse-failed');
  expect(diagnostic).not.toContain('AAAASensitiveKey');
  consoleError.mockRestore();
});

test('stores a confirmed host globally and sends structured nonstandard-port data', async () => {
  const next = await trustKnownHost([], {
    host: 'Thinker.Example',
    port: 2222,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAANewKey',
    fingerprint: 'SHA256:new',
  });

  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({
    host: 'Thinker.Example',
    port: 2222,
    keyType: 'ssh-ed25519',
  });
  expect(next[0].id).toMatch(/^known-host-/);
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    KNOWN_HOSTS_STORAGE_KEY,
    expect.any(String),
  );
  expect(SSHClient.setTrustedHostKeys).toHaveBeenLastCalledWith([{
    host: 'Thinker.Example',
    port: 2222,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAANewKey',
  }]);
});

test('persists the native-produced public key without interpreting OpenSSH syntax', async () => {
  const next = await trustKnownHost([], {
    host: 'Mini',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
    fingerprint: 'SHA256:ios',
  });

  expect(next[0].publicKey).toBe('ssh-ed25519 AAAAIosKey mini');
  expect(SSHClient.setTrustedHostKeys).toHaveBeenLastCalledWith([{
    host: 'Mini',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
  }]);
});

test('deduplicates trusted native challenges by fingerprint', async () => {
  const legacyHost: KnownHost = {
    ...knownHost,
    host: 'mini',
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
  };

  const next = await trustKnownHost([legacyHost], {
    host: 'mini',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
    fingerprint: legacyHost.fingerprint,
  });

  expect(next).toHaveLength(1);
  expect(next).toEqual([legacyHost]);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(SSHClient.setTrustedHostKeys).toHaveBeenLastCalledWith([{
    host: 'mini',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
  }]);
});

test('parses an unknown-key challenge returned by the native handshake', () => {
  expect(
    parseUnknownHostKey({
      code: 'HOST_KEY_UNKNOWN',
      message: 'unknown SSH host key',
      details: {
        host: 'Savior',
        port: 22,
        keyType: 'ssh-ed25519',
        publicKey: 'AAAA',
        fingerprint: 'SHA256:key',
      },
    }),
  ).toEqual({
    host: 'Savior',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAA',
    fingerprint: 'SHA256:key',
  });
  expect(parseUnknownHostKey('HostKey has been changed')).toBeNull();
  expect(
    hostKeyErrorHost({
      code: 'HOST_KEY_CHANGED',
      details: { host: 'Jump.Example', port: 2222 },
    }),
  ).toBe('[Jump.Example]:2222');
});

test('does not persist trusted host material rejected by Rust validation', async () => {
  jest.mocked(SSHClient.setTrustedHostKeys).mockImplementationOnce(() => {
    throw new Error('trusted host key is malformed');
  });

  await expect(trustKnownHost([], {
    host: 'invalid.example',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'not-base64',
    fingerprint: 'SHA256:invalid',
  })).rejects.toThrow('malformed');

  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

test('forgetting a host immediately replaces the native repository', async () => {
  await expect(deleteKnownHost([knownHost], knownHost.id)).resolves.toEqual([]);
  expect(mockStoredKnownHosts).toBe('[]');
  expect(SSHClient.setTrustedHostKeys).toHaveBeenLastCalledWith([]);
});

test('logs known-host write rejection without exposing public-key material', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('write unavailable');
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(error);

  await expect(deleteKnownHost([knownHost], knownHost.id)).rejects.toBe(error);

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-write-failed');
  expect(diagnostic).not.toContain(knownHost.publicKey);
  consoleError.mockRestore();
});
