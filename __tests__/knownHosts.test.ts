import AsyncStorage from '@react-native-async-storage/async-storage';
import SSHClient from '@dylankenneally/react-native-ssh-sftp';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  KNOWN_HOSTS_STORAGE_KEY,
  deleteKnownHost,
  hostKeyErrorHost,
  loadKnownHosts,
  parseUnknownHostKey,
  serializeKnownHosts,
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

jest.mock('@dylankenneally/react-native-ssh-sftp', () => ({
  __esModule: true,
  default: {
    setKnownHosts: jest.fn(),
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
  expect(SSHClient.setKnownHosts).toHaveBeenCalledWith(
    'savior.tailnet.ts.net ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest',
  );
});

test('stores a confirmed host globally and uses OpenSSH nonstandard-port syntax', async () => {
  const next = await trustKnownHost([], {
    host: 'Thinker.Example',
    port: 2222,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAANewKey',
    fingerprint: 'SHA256:new',
  });

  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({
    host: 'thinker.example',
    port: 2222,
    keyType: 'ssh-ed25519',
  });
  expect(next[0].id).toMatch(/^known-host-/);
  expect(serializeKnownHosts(next)).toBe(
    '[thinker.example]:2222 ssh-ed25519 AAAANewKey',
  );
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    KNOWN_HOSTS_STORAGE_KEY,
    expect.any(String),
  );
  expect(SSHClient.setKnownHosts).toHaveBeenLastCalledWith(
    '[thinker.example]:2222 ssh-ed25519 AAAANewKey',
  );
});

test('parses an unknown-key challenge returned by the native handshake', () => {
  expect(parseUnknownHostKey(
    'E_HOST_KEY_UNKNOWN:{"host":"Savior","port":22,"keyType":"ssh-ed25519","publicKey":"AAAA","fingerprint":"SHA256:key"}',
  )).toEqual({
    host: 'savior',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAA',
    fingerprint: 'SHA256:key',
  });
  expect(parseUnknownHostKey('HostKey has been changed')).toBeNull();
  expect(hostKeyErrorHost(
    'E_HOST_KEY_CHANGED:{"host":"Jump.Example","port":2222}',
  )).toBe('[jump.example]:2222');
});

test('forgetting a host immediately replaces the native repository', async () => {
  await expect(deleteKnownHost([knownHost], knownHost.id)).resolves.toEqual([]);
  expect(mockStoredKnownHosts).toBe('[]');
  expect(SSHClient.setKnownHosts).toHaveBeenLastCalledWith('');
});

test('enforces the repository during the native SSH handshake', () => {
  const android = readFileSync(
    resolve(
      __dirname,
      '../packages/react-native-ssh-sftp/android/src/main/java/me/dylankenneally/rnssh/RNSshClientModule.java',
    ),
    'utf8',
  );
  const connect = android.slice(
    android.indexOf('private void connectToHost('),
    android.indexOf('public void execute('),
  );

  expect(connect).toContain('jsch.setKnownHosts(');
  expect(connect).toContain('session.setHostKeyAlias(hostKeyAlias(host, port))');
  expect(connect).toContain('properties.setProperty("StrictHostKeyChecking", "yes")');
  expect(connect).not.toContain('properties.setProperty("StrictHostKeyChecking", "no")');
  expect(connect).toContain('"E_HOST_KEY_UNKNOWN:"');
  expect(connect).toContain('"E_HOST_KEY_CHANGED:"');
});
