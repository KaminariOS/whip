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
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

interface StoredCredential {
  secret?: string;
  passphrase?: string;
}

export const CREDENTIAL_BACKUP_MIGRATION_KEY = 'herdr.credentials.backup-migration';
export const CREDENTIAL_BACKUP_MIGRATION_VERSION = '1';
let credentialBackupMigration: Promise<void> | null = null;

export async function loadHostProfiles(): Promise<HostProfile[]> {
  let entries: readonly [string, string | null][];
  try {
    entries = await AsyncStorage.multiGet([HOSTS_STORAGE_KEY, LEGACY_PROFILE_KEY]);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'host-profiles',
      phase: 'startup-fallback',
      operation: 'multiGet',
      fallbackUsed: 'empty-hosts',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  const values = new Map(entries);
  const hosts = await loadHostProfilesFromStorage(
    values.get(HOSTS_STORAGE_KEY) ?? null,
    values.get(LEGACY_PROFILE_KEY) ?? null,
  );
  scheduleCredentialBackupMigration(hosts);
  return hosts;
}

/** Parses current host metadata without touching Keychain or credential backups. */
export async function loadHostProfilesFromStorage(
  stored: string | null,
  legacyValue: string | null,
): Promise<HostProfile[]> {
  if (stored !== null) {
    return parseHosts(stored, error => {
      recordHostProfilesParseFailure(error, HOSTS_STORAGE_KEY, 'empty-hosts');
    });
  }

  const legacy = migrateLegacyProfile(legacyValue, error => {
    recordHostProfilesParseFailure(error, LEGACY_PROFILE_KEY, 'empty-hosts');
  });
  if (!legacy) return [];

  const credential = await Keychain.getGenericPassword({ service: LEGACY_CREDENTIAL_SERVICE });
  const secrets = parseCredential(credential ? credential.password : null);
  const migrated = { ...legacy, ...secrets };
  const host = toHostProfile(migrated);

  await writeHostProfiles(JSON.stringify([host]), 'startup-migration');
  if (migrated.secret) {
    await writeCredential(migrated);
  }
  return [host];
}

/** Runs the one-time backup migration without delaying host metadata rendering. */
export function scheduleCredentialBackupMigration(hosts: readonly HostProfile[]): void {
  if (credentialBackupMigration) return;
  const operation = migrateCredentialBackupsIfNeeded(hosts).catch(() => undefined);
  credentialBackupMigration = operation;
  operation.finally(() => {
    if (credentialBackupMigration === operation) credentialBackupMigration = null;
  }).catch(() => undefined);
}

export async function migrateCredentialBackupsIfNeeded(hosts: readonly HostProfile[]): Promise<void> {
  let migrationVersion: string | null;
  try {
    migrationVersion = await AsyncStorage.getItem(CREDENTIAL_BACKUP_MIGRATION_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'credential-backup-migration',
      storageKey: CREDENTIAL_BACKUP_MIGRATION_KEY,
      phase: 'startup-migration',
      operation: 'getItem',
      fallbackUsed: 'retry-next-launch',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  if (migrationVersion === CREDENTIAL_BACKUP_MIGRATION_VERSION) return;
  let complete = true;
  for (const host of hosts) {
    try {
      const credential = await Keychain.getGenericPassword({ service: hostCredentialService(host.id) });
      const secrets = parseCredential(credential ? credential.password : null);
      if (secrets.secret) await ensureCredentialBackup(host.id, secrets);
    } catch {
      complete = false;
    }
  }
  if (complete) {
    try {
      await AsyncStorage.setItem(CREDENTIAL_BACKUP_MIGRATION_KEY, CREDENTIAL_BACKUP_MIGRATION_VERSION);
    } catch (error) {
      recordStorageDiagnostic('error', 'storage-write-failed', {
        store: 'credential-backup-migration',
        storageKey: CREDENTIAL_BACKUP_MIGRATION_KEY,
        phase: 'startup-migration',
        operation: 'setItem',
        fallbackUsed: 'retry-next-launch',
        ...storageErrorDetails(error),
      });
      throw error;
    }
  }
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
  await writeHostProfiles(JSON.stringify(nextHosts), 'profile-save');

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
  await writeHostProfiles(JSON.stringify(next), 'disconnect-persistence');
  return next;
}

export async function deleteHostProfile(hosts: HostProfile[], id: string): Promise<HostProfile[]> {
  const now = new Date().toISOString();
  const next = hosts
    .filter(host => host.id !== id)
    .map(host => host.jumpHostId === id
      ? { ...host, jumpHostId: undefined, updatedAt: now }
      : host);
  await writeHostProfiles(JSON.stringify(next), 'profile-delete');
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

async function writeHostProfiles(value: string, phase: string): Promise<void> {
  try {
    await AsyncStorage.setItem(HOSTS_STORAGE_KEY, value);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-write-failed', {
      store: 'host-profiles',
      storageKey: HOSTS_STORAGE_KEY,
      phase,
      operation: 'setItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

function recordHostProfilesParseFailure(
  error: unknown,
  storageKey: string,
  fallbackUsed: string,
): void {
  recordStorageDiagnostic('error', 'storage-parse-failed', {
    store: 'host-profiles',
    storageKey,
    phase: 'startup',
    operation: 'parse',
    fallbackUsed,
    ...storageParseErrorDetails(error),
  });
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
