import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { NativeModules, Platform } from 'react-native';

import { hostCredentialService } from '../lib/hostProfiles';
import type { HostProfile } from '../types';

const CREDENTIAL_BACKUPS_KEY = 'herdr.credential.backups.v1';

interface StoredCredential {
  secret: string;
  passphrase: string;
}

interface CredentialVaultNativeModule {
  hasLocalRecoveryKey(): Promise<boolean>;
  encryptCredential(plaintext: string, credentialId: string): Promise<string>;
  decryptCredential(ciphertext: string, credentialId: string): Promise<string>;
  unlockRecoveryKey(): Promise<boolean>;
  clearRecoveryKey(): Promise<void>;
}

export interface CredentialRecoveryStatus {
  state: 'none' | 'ready' | 'locked' | 'unavailable';
  count: number;
}

export interface CredentialRestoreResult {
  restored: number;
  failed: number;
}

let backupMutation = Promise.resolve();

function nativeModule(): CredentialVaultNativeModule | null {
  if (Platform.OS !== 'android') return null;
  return NativeModules.HerdrCredentialVault as CredentialVaultNativeModule | undefined || null;
}

export async function backupCredential(
  hostId: string,
  credential: StoredCredential,
): Promise<boolean> {
  const module = nativeModule();
  if (!module || !credential.secret) return false;
  let backedUp = false;
  const operation = backupMutation.then(async () => {
    const ciphertext = await module.encryptCredential(JSON.stringify(credential), hostId);
    const backups = await loadBackups();
    await AsyncStorage.setItem(CREDENTIAL_BACKUPS_KEY, JSON.stringify({
      ...backups,
      [hostId]: ciphertext,
    }));
    backedUp = true;
  });
  backupMutation = operation.catch(() => undefined);
  try {
    await operation;
    return backedUp;
  } catch {
    return false;
  }
}

export async function ensureCredentialBackup(
  hostId: string,
  credential: StoredCredential,
): Promise<boolean> {
  if ((await loadBackups())[hostId]) return true;
  return backupCredential(hostId, credential);
}

export async function removeCredentialBackup(hostId: string): Promise<void> {
  const remaining = await mutateBackups(backups => {
    const next = { ...backups };
    delete next[hostId];
    return next;
  });
  if (Object.keys(remaining).length === 0) {
    await nativeModule()?.clearRecoveryKey().catch(() => undefined);
  }
}

export async function credentialRecoveryStatus(): Promise<CredentialRecoveryStatus> {
  const backups = await loadBackups();
  const count = Object.keys(backups).length;
  if (count === 0) return { state: 'none', count: 0 };
  const module = nativeModule();
  if (!module) return { state: 'unavailable', count };
  try {
    return {
      state: await module.hasLocalRecoveryKey() ? 'ready' : 'locked',
      count,
    };
  } catch {
    return { state: 'unavailable', count };
  }
}

export async function restoreCredentialBackups(
  hosts: HostProfile[],
): Promise<CredentialRestoreResult> {
  const module = nativeModule();
  if (!module) throw new Error('Credential recovery requires a new Android app build');
  const backups = await loadBackups();
  if (Object.keys(backups).length === 0) return { restored: 0, failed: 0 };
  await module.unlockRecoveryKey();

  let restored = 0;
  let failed = 0;
  for (const host of hosts) {
    const ciphertext = backups[host.id];
    if (!ciphertext || !host.rememberCredentials) continue;
    try {
      const credential = parseCredential(await module.decryptCredential(ciphertext, host.id));
      if (!credential.secret) throw new Error('Credential backup is empty');
      await writeKeychainCredential(host, credential);
      restored += 1;
    } catch {
      failed += 1;
    }
  }
  return { restored, failed };
}

export async function recoverCredentialForHost(
  host: HostProfile,
): Promise<StoredCredential | null> {
  const module = nativeModule();
  if (!module || !host.rememberCredentials) return null;
  const ciphertext = (await loadBackups())[host.id];
  if (!ciphertext || !await module.hasLocalRecoveryKey()) return null;
  try {
    const credential = parseCredential(await module.decryptCredential(ciphertext, host.id));
    if (!credential.secret) return null;
    await writeKeychainCredential(host, credential);
    return credential;
  } catch {
    return null;
  }
}

async function writeKeychainCredential(host: HostProfile, credential: StoredCredential): Promise<void> {
  await Keychain.setGenericPassword(host.username, JSON.stringify(credential), {
    service: hostCredentialService(host.id),
  });
}

function parseCredential(value: string): StoredCredential {
  const parsed = JSON.parse(value) as Partial<StoredCredential>;
  return {
    secret: typeof parsed.secret === 'string' ? parsed.secret : '',
    passphrase: typeof parsed.passphrase === 'string' ? parsed.passphrase : '',
  };
}

async function loadBackups(): Promise<Record<string, string>> {
  const value = await AsyncStorage.getItem(CREDENTIAL_BACKUPS_KEY);
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

async function mutateBackups(
  mutation: (backups: Record<string, string>) => Record<string, string>,
): Promise<Record<string, string>> {
  let result: Record<string, string> = {};
  const operation = backupMutation.then(async () => {
    result = mutation(await loadBackups());
    await AsyncStorage.setItem(CREDENTIAL_BACKUPS_KEY, JSON.stringify(result));
  });
  backupMutation = operation.catch(() => undefined);
  await operation;
  return result;
}
