import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import { toHostProfile } from '../src/lib/hostProfiles';
import { deleteHostProfile, saveConnectionProfile } from '../src/services/hostProfiles';
import { backupCredential, removeCredentialBackup } from '../src/services/credentialVault';
import type { ConnectionProfile } from '../src/types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
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
