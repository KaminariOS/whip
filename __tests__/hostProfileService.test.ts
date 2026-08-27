import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import { toHostProfile } from '../src/lib/hostProfiles';
import {
  CREDENTIAL_BACKUP_MIGRATION_KEY,
  CREDENTIAL_BACKUP_MIGRATION_VERSION,
  deleteHostProfile,
  loadConnectionProfile,
  loadHostProfiles,
  loadHostProfilesFromStorage,
  migrateCredentialBackupsIfNeeded,
  saveConnectionProfile,
} from '../src/services/hostProfiles';
import {
  backupCredential,
  ensureCredentialBackup,
  recoverCredentialForHost,
  removeCredentialBackup,
} from '../src/services/credentialVault';
import type { ConnectionProfile } from '../src/types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    multiGet: jest.fn(() => Promise.resolve([])),
    setItem: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
  STORAGE_TYPE: { AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth' },
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  resetGenericPassword: jest.fn(() => Promise.resolve(true)),
  setGenericPassword: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../src/services/credentialVault', () => ({
  backupCredential: jest.fn(() => Promise.resolve(true)),
  ensureCredentialBackup: jest.fn(() => Promise.resolve(true)),
  recoverCredentialForHost: jest.fn(() => Promise.resolve(null)),
  removeCredentialBackup: jest.fn(() => Promise.resolve()),
}));

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Savior',
  host: 'savior',
  port: '22',
  username: 'kosumi',
  authMode: 'key',
  secret: '',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('returns current host metadata without touching Keychain', async () => {
  const hostProfile = toHostProfile(profile);
  const stored = JSON.stringify([hostProfile]);

  await expect(loadHostProfilesFromStorage(stored, null)).resolves.toEqual([hostProfile]);
  expect(Keychain.getGenericPassword).not.toHaveBeenCalled();
});

test('logs host metadata fallback read failure without changing rejection behavior', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('read unavailable');
  jest.mocked(AsyncStorage.multiGet).mockRejectedValueOnce(error);

  await expect(loadHostProfiles()).rejects.toBe(error);

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-read-failed',
  ));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '"store":"host-profiles"',
  ));
  consoleError.mockRestore();
});

test('logs malformed host metadata without exposing its contents', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  await expect(loadHostProfilesFromStorage('{private host metadata', null)).resolves.toEqual([]);

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-parse-failed');
  expect(diagnostic).not.toContain('private host metadata');
  consoleError.mockRestore();
});

test('runs credential backup migration once per recorded version', async () => {
  jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(null);
  jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce({
    service: 'host',
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
    username: profile.username,
    password: JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'phrase' }),
  });

  await migrateCredentialBackupsIfNeeded([toHostProfile(profile)]);

  expect(ensureCredentialBackup).toHaveBeenCalledWith('host-1', {
    secret: 'PRIVATE KEY',
    passphrase: 'phrase',
  });
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    CREDENTIAL_BACKUP_MIGRATION_KEY,
    CREDENTIAL_BACKUP_MIGRATION_VERSION,
  );

  jest.clearAllMocks();
  jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(CREDENTIAL_BACKUP_MIGRATION_VERSION);
  await migrateCredentialBackupsIfNeeded([toHostProfile(profile)]);
  expect(Keychain.getGenericPassword).not.toHaveBeenCalled();
  expect(ensureCredentialBackup).not.toHaveBeenCalled();
});

test('falls back to credential recovery when primary Keychain material is malformed', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce({
    service: 'host',
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
    username: profile.username,
    password: '{malformed credential',
  });
  jest.mocked(recoverCredentialForHost).mockResolvedValueOnce({
    secret: 'RECOVERED KEY',
    passphrase: 'recovered phrase',
  });

  await expect(loadConnectionProfile(toHostProfile(profile))).resolves.toMatchObject({
    secret: 'RECOVERED KEY',
    passphrase: 'recovered phrase',
  });

  expect(recoverCredentialForHost).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('keychain-credential-parse-failed'));
  consoleError.mockRestore();
});

test('diagnoses failed credential backup migration items and retries next launch', async () => {
  const consoleWarn = jest.spyOn(console, 'warn').mockImplementation();
  jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(null);
  jest.mocked(Keychain.getGenericPassword).mockRejectedValueOnce(new Error('keychain unavailable'));

  await migrateCredentialBackupsIfNeeded([toHostProfile(profile)]);

  expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining(
    'credential-backup-migration-item-failed',
  ));
  expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
    CREDENTIAL_BACKUP_MIGRATION_KEY,
    CREDENTIAL_BACKUP_MIGRATION_VERSION,
  );
  consoleWarn.mockRestore();
});

test('always stores a provided credential', async () => {
  const withKey = {
    ...profile,
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  };

  await saveConnectionProfile([toHostProfile(profile)], withKey);

  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'kosumi',
    JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'key phrase' }),
    {
      accessible: 'WhenUnlockedThisDeviceOnly',
      service: 'io.github.kaminarios.whip.ssh.host.host-1',
    },
  );
  expect(backupCredential).toHaveBeenCalledWith('host-1', {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  });
});

test('logs host metadata write failure without exposing credentials', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('write unavailable');
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(error);

  await expect(saveConnectionProfile([], {
    ...profile,
    secret: 'PRIVATE KEY CONTENT',
    passphrase: 'secret phrase',
  })).rejects.toBe(error);

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-write-failed');
  expect(diagnostic).not.toContain('PRIVATE KEY CONTENT');
  expect(diagnostic).not.toContain('secret phrase');
  consoleError.mockRestore();
});

test('removes a saved credential when its private key is cleared', async () => {
  await saveConnectionProfile([toHostProfile(profile)], profile);

  expect(AsyncStorage.setItem).toHaveBeenCalled();
  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
    service: 'io.github.kaminarios.whip.ssh.host.host-1',
  });
  expect(removeCredentialBackup).toHaveBeenCalledWith('host-1');
});

test('clears jump-host references when the selected host is deleted', async () => {
  const jumpHost = { ...toHostProfile(profile), id: 'jump' };
  const target = { ...toHostProfile(profile), id: 'target', jumpHostId: jumpHost.id };

  const next = await deleteHostProfile([target, jumpHost], jumpHost.id);

  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({ id: 'target' });
  expect(next[0].jumpHostId).toBeUndefined();
  expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
    'herdr.hosts.v2',
    JSON.stringify(next),
  );
});
