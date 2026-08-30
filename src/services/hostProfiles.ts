import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import {
  HOSTS_STORAGE_KEY,
  LEGACY_CREDENTIAL_SERVICE,
  LEGACY_PROFILE_KEY,
  hostCredentialService,
  hydrateHostProfiles,
  migrateLegacyProfile,
  parseHosts,
  prepareHostDisconnected,
  prepareHostRemoval,
  prepareHostUpsert,
  resolveJumpHostChain,
  toHostProfile,
} from '../lib/hostProfiles';
import type { ConnectionProfile, HostProfile } from '../types';
import { reportBackgroundFailure } from './backgroundOperations';
import {
  backupCredential,
  ensureCredentialBackup,
  recoverCredentialForHost,
  removeCredentialBackup,
} from './credentialVault';
import {
  operationalErrorDetails,
  operationalParseErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';
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
  if (!legacy) return parseHosts(null);

  const credential = await Keychain.getGenericPassword({ service: LEGACY_CREDENTIAL_SERVICE });
  const secrets = parseCredential(credential ? credential.password : null, legacy.id)
    || { secret: '', passphrase: '' };
  const migrated = { ...legacy, ...secrets };
  const host = toHostProfile(migrated);

  await writeHostProfiles(JSON.stringify([host]), 'startup-migration');
  hydrateHostProfiles([host]);
  if (migrated.secret) {
    await writeCredential(migrated);
  }
  return [host];
}

/** Runs the one-time backup migration without delaying host metadata rendering. */
export function scheduleCredentialBackupMigration(hosts: readonly HostProfile[]): void {
  if (credentialBackupMigration) return;
  const operation = migrateCredentialBackupsIfNeeded(hosts);
  credentialBackupMigration = operation;
  reportBackgroundFailure(operation, 'credential-backup-migration');
  const clearMigration = () => {
    if (credentialBackupMigration === operation) credentialBackupMigration = null;
  };
  operation.then(clearMigration, clearMigration);
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
    let stage = 'keychain-read';
    try {
      const credential = await Keychain.getGenericPassword({ service: hostCredentialService(host.id) });
      if (!credential) continue;
      stage = 'credential-parse';
      const secrets = parseCredential(credential.password, host.id);
      if (!secrets) throw new Error('Stored Keychain credential is malformed or empty');
      stage = 'credential-backup';
      if (!await ensureCredentialBackup(host.id, secrets)) {
        throw new Error('Credential backup was not created');
      }
    } catch (error) {
      recordOperationalDiagnostic('warn', 'Credential', 'credential-backup-migration-item-failed', {
        hostId: host.id,
        stage,
        fallbackUsed: 'retry-next-launch',
        ...operationalErrorDetails(error),
      });
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
  let credential: false | Keychain.UserCredentials = false;
  try {
    credential = await Keychain.getGenericPassword({ service: hostCredentialService(host.id) });
  } catch (error) {
    recordOperationalDiagnostic('error', 'Credential', 'keychain-credential-read-failed', {
      hostId: host.id,
      ...operationalErrorDetails(error),
    });
  }
  const primary = credential ? parseCredential(credential.password, host.id) : null;
  const secrets = primary
    || await recoverCredentialForHost(host)
    || { secret: '', passphrase: '' };
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
  const next = prepareHostUpsert(hosts, host);
  try {
    await writeHostProfiles(next.persistedValue, 'profile-save');
  } catch (error) {
    hydrateHostProfiles(hosts);
    throw error;
  }

  if (profile.secret) {
    await writeCredential(profile);
  } else {
    await Keychain.resetGenericPassword({ service: hostCredentialService(profile.id) });
    await removeCredentialBackup(profile.id);
  }
  return { hosts: next.hosts, host };
}

/** Records when the host connection ended; the Hosts screen presents this as last connected. */
export async function markHostDisconnected(hosts: HostProfile[], id: string): Promise<HostProfile[]> {
  const now = new Date().toISOString();
  const next = prepareHostDisconnected(hosts, id, now);
  try {
    await writeHostProfiles(next.persistedValue, 'disconnect-persistence');
  } catch (error) {
    hydrateHostProfiles(hosts);
    throw error;
  }
  return next.hosts;
}

export async function deleteHostProfile(hosts: HostProfile[], id: string): Promise<HostProfile[]> {
  const now = new Date().toISOString();
  const next = prepareHostRemoval(hosts, id, now);
  try {
    await writeHostProfiles(next.persistedValue, 'profile-delete');
  } catch (error) {
    hydrateHostProfiles(hosts);
    throw error;
  }
  await Keychain.resetGenericPassword({ service: hostCredentialService(id) });
  await removeCredentialBackup(id);
  return next.hosts;
}

async function writeCredential(profile: ConnectionProfile): Promise<void> {
  try {
    const result = await Keychain.setGenericPassword(profile.username, JSON.stringify({
      secret: profile.secret,
      passphrase: profile.passphrase,
    }), {
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      service: hostCredentialService(profile.id),
    });
    if (!result) throw new Error('Keychain did not store the host credential');
  } catch (error) {
    recordOperationalDiagnostic('error', 'Credential', 'keychain-credential-write-failed', {
      hostId: profile.id,
      ...operationalErrorDetails(error),
    });
    throw error;
  }
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

function parseCredential(
  value: string | null,
  hostId: string,
): Required<StoredCredential> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Stored Keychain credential must be an object');
    }
    const credential = parsed as StoredCredential;
    if (
      typeof credential.secret !== 'string'
      || (
        credential.passphrase !== undefined
        && typeof credential.passphrase !== 'string'
      )
    ) {
      throw new TypeError('Stored Keychain credential has invalid fields');
    }
    if (!credential.secret) {
      recordOperationalDiagnostic('error', 'Credential', 'keychain-credential-empty', {
        hostId,
        fallbackUsed: 'credential-recovery',
      });
      return null;
    }
    return { secret: credential.secret, passphrase: credential.passphrase || '' };
  } catch (error) {
    recordOperationalDiagnostic('error', 'Credential', 'keychain-credential-parse-failed', {
      hostId,
      fallbackUsed: 'credential-recovery',
      ...operationalParseErrorDetails(error),
    });
    return null;
  }
}
