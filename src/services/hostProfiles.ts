import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import {
  HOSTS_STORAGE_KEY,
  LEGACY_CREDENTIAL_SERVICE,
  LEGACY_PROFILE_KEY,
  hostCredentialService,
  migrateLegacyProfile,
  parseHosts,
  resolveJumpHostChain,
  sortHosts,
  toHostProfile,
  upsertHost,
} from '../lib/hostProfiles';
import type { ConnectionProfile, HostProfile } from '../types';
import {
  backupCredential,
  ensureCredentialBackup,
  recoverCredentialForHost,
  removeCredentialBackup,
} from './credentialVault';

interface StoredCredential {
  secret?: string;
  passphrase?: string;
}

export async function loadHostProfiles(): Promise<HostProfile[]> {
  const stored = await AsyncStorage.getItem(HOSTS_STORAGE_KEY);
  if (stored !== null) {
    const hosts = parseHosts(stored);
    await migrateStoredCredentialBackups(hosts);
    return hosts;
  }

  const legacyValue = await AsyncStorage.getItem(LEGACY_PROFILE_KEY);
  const legacy = migrateLegacyProfile(legacyValue);
  if (!legacy) return [];

  const credential = await Keychain.getGenericPassword({ service: LEGACY_CREDENTIAL_SERVICE });
  const secrets = parseCredential(credential ? credential.password : null);
  const migrated = { ...legacy, ...secrets };
  const host = toHostProfile(migrated);

  await AsyncStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify([host]));
  if (migrated.secret) {
    await writeCredential(migrated);
  }
  return [host];
}

export async function loadConnectionProfile(host: HostProfile): Promise<ConnectionProfile> {
  const credential = await Keychain.getGenericPassword({ service: hostCredentialService(host.id) });
  const secrets = credential
    ? parseCredential(credential.password)
    : await recoverCredentialForHost(host) || { secret: '', passphrase: '' };
  return {
    ...host,
    ...secrets,
  };
}

export async function loadJumpHostConnectionProfiles(
  hosts: HostProfile[],
  profile: Pick<HostProfile, 'id' | 'jumpHostId'>,
): Promise<ConnectionProfile[]> {
  const jumpHosts = resolveJumpHostChain(hosts, profile);
  return Promise.all(jumpHosts.map(loadConnectionProfile));
}

export async function saveConnectionProfile(
  hosts: HostProfile[],
  profile: ConnectionProfile,
): Promise<{ hosts: HostProfile[]; host: HostProfile }> {
  const previous = hosts.find(host => host.id === profile.id);
  const host = toHostProfile(profile, previous);
  const nextHosts = upsertHost(hosts, host);
  await AsyncStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(nextHosts));

  if (profile.secret) {
    await writeCredential(profile);
  } else {
    await Keychain.resetGenericPassword({ service: hostCredentialService(profile.id) });
    await removeCredentialBackup(profile.id);
  }
  return { hosts: nextHosts, host };
}

/** Records when the host connection ended; the Hosts screen presents this as last connected. */
export async function markHostDisconnected(hosts: HostProfile[], id: string): Promise<HostProfile[]> {
  const now = new Date().toISOString();
  const next = sortHosts(hosts.map(host => (
    host.id === id ? { ...host, lastConnectedAt: now, updatedAt: now } : host
  )));
  await AsyncStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export async function deleteHostProfile(hosts: HostProfile[], id: string): Promise<HostProfile[]> {
  const now = new Date().toISOString();
  const next = hosts
    .filter(host => host.id !== id)
    .map(host => host.jumpHostId === id
      ? { ...host, jumpHostId: undefined, updatedAt: now }
      : host);
  await AsyncStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(next));
  await Keychain.resetGenericPassword({ service: hostCredentialService(id) });
  await removeCredentialBackup(id);
  return next;
}

async function writeCredential(profile: ConnectionProfile): Promise<void> {
  await Keychain.setGenericPassword(profile.username, JSON.stringify({
    secret: profile.secret,
    passphrase: profile.passphrase,
  }), {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    service: hostCredentialService(profile.id),
  });
  await backupCredential(profile.id, {
    secret: profile.secret,
    passphrase: profile.passphrase,
  });
}

async function migrateStoredCredentialBackups(hosts: HostProfile[]): Promise<void> {
  for (const host of hosts) {
    try {
      const credential = await Keychain.getGenericPassword({ service: hostCredentialService(host.id) });
      const secrets = parseCredential(credential ? credential.password : null);
      if (secrets.secret) await ensureCredentialBackup(host.id, secrets);
    } catch {
      // Local credentials remain usable even when Block Store is unavailable.
    }
  }
}

function parseCredential(value: string | null): Required<StoredCredential> {
  if (!value) return { secret: '', passphrase: '' };
  try {
    const parsed = JSON.parse(value) as StoredCredential;
    return {
      secret: typeof parsed.secret === 'string' ? parsed.secret : '',
      passphrase: typeof parsed.passphrase === 'string' ? parsed.passphrase : '',
    };
  } catch {
    return { secret: '', passphrase: '' };
  }
}
