const mockNativeVault = {
  hasLocalRecoveryKey: jest.fn(),
  encryptCredential: jest.fn(),
  decryptCredential: jest.fn(),
  unlockRecoveryKey: jest.fn(),
  clearRecoveryKey: jest.fn(),
};
let mockStoredBackups: string | null = null;

jest.mock('react-native', () => {
  return {
    NativeModules: {},
    Platform: { OS: 'android' },
  };
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(mockStoredBackups)),
    setItem: jest.fn((_key: string, value: string) => {
      mockStoredBackups = value;
      return Promise.resolve();
    }),
  },
}));

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(() => Promise.resolve(true)),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { NativeModules } from 'react-native';
import {
  backupCredential,
  credentialRecoveryStatus,
  ensureCredentialBackup,
  removeCredentialBackup,
  restoreCredentialBackups,
} from '../src/services/credentialVault';
import type { HostProfile } from '../src/types';

const host: HostProfile = {
  id: 'host-1',
  name: 'Savior',
  host: 'savior',
  port: '22',
  username: 'kosumi',
  authMode: 'key',
  herdrCommand: 'herdr',
  sessionName: '',
  rememberCredentials: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  NativeModules.HerdrCredentialVault = mockNativeVault;
  mockStoredBackups = null;
  jest.clearAllMocks();
  mockNativeVault.hasLocalRecoveryKey.mockResolvedValue(true);
  mockNativeVault.encryptCredential.mockResolvedValue('v1.iv.ciphertext');
  mockNativeVault.decryptCredential.mockResolvedValue(JSON.stringify({
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  }));
  mockNativeVault.unlockRecoveryKey.mockResolvedValue(true);
  mockNativeVault.clearRecoveryKey.mockResolvedValue(undefined);
});

test('stores only native-encrypted credential backup text in AsyncStorage', async () => {
  await expect(backupCredential(host.id, {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  })).resolves.toBe(true);

  expect(mockNativeVault.encryptCredential).toHaveBeenCalledWith(
    JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'key phrase' }),
    host.id,
  );
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    'herdr.credential.backups.v1',
    JSON.stringify({ [host.id]: 'v1.iv.ciphertext' }),
  );
  expect(mockStoredBackups).not.toContain('PRIVATE KEY');
  expect(mockStoredBackups).not.toContain('key phrase');
});

test('reports restored credential backups as locked when the local key was uninstalled', async () => {
  mockStoredBackups = JSON.stringify({ [host.id]: 'v1.iv.ciphertext' });
  mockNativeVault.hasLocalRecoveryKey.mockResolvedValue(false);

  await expect(credentialRecoveryStatus()).resolves.toEqual({ state: 'locked', count: 1 });
});

test('does not re-encrypt a credential that already has a recovery backup', async () => {
  mockStoredBackups = JSON.stringify({ [host.id]: 'v1.iv.ciphertext' });

  await expect(ensureCredentialBackup(host.id, {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  })).resolves.toBe(true);

  expect(mockNativeVault.encryptCredential).not.toHaveBeenCalled();
});

test('unlocks, decrypts, and reimports restored credentials into Keychain', async () => {
  mockStoredBackups = JSON.stringify({ [host.id]: 'v1.iv.ciphertext' });

  await expect(restoreCredentialBackups([host])).resolves.toEqual({ restored: 1, failed: 0 });

  expect(mockNativeVault.unlockRecoveryKey).toHaveBeenCalledTimes(1);
  expect(mockNativeVault.decryptCredential).toHaveBeenCalledWith('v1.iv.ciphertext', host.id);
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    host.username,
    JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'key phrase' }),
    { service: 'dev.herdr.remote.ssh.host.host-1' },
  );
});

test('clears the Block Store recovery key after the final backup is removed', async () => {
  mockStoredBackups = JSON.stringify({ [host.id]: 'v1.iv.ciphertext' });

  await removeCredentialBackup(host.id);

  expect(mockStoredBackups).toBe('{}');
  expect(mockNativeVault.clearRecoveryKey).toHaveBeenCalledTimes(1);
});
