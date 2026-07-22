import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import type { GlobalSshKey, GlobalSshKeyMaterial } from '../types';
import { authenticateGlobalKeychain } from './appAuthentication';

export const GLOBAL_SSH_KEYS_STORAGE_KEY = 'herdr.global-ssh-keys.v1';
export const GLOBAL_SSH_KEYCHAIN_SERVICE = 'io.github.kaminarios.whip.ssh.global-keychain.v1';

interface StoredKeyMaterial {
  id: string;
  secret: string;
  passphrase: string;
}

export interface SaveGlobalSshKeyInput {
  name: string;
  fingerprint: string;
  keyType: string;
  secret: string;
  passphrase: string;
}

let keychainMutation = Promise.resolve();

export async function loadGlobalSshKeys(): Promise<GlobalSshKey[]> {
  const value = await AsyncStorage.getItem(GLOBAL_SSH_KEYS_STORAGE_KEY);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isGlobalSshKey).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export async function unlockGlobalSshKeychain(): Promise<GlobalSshKeyMaterial[]> {
  await authenticateGlobalKeychain();
  return loadGlobalSshKeyMaterials();
}

async function loadGlobalSshKeyMaterials(): Promise<GlobalSshKeyMaterial[]> {
  const [keys, credential] = await Promise.all([
    loadGlobalSshKeys(),
    Keychain.getGenericPassword({ service: GLOBAL_SSH_KEYCHAIN_SERVICE }),
  ]);
  const materials = parseMaterials(credential ? credential.password : null);
  return keys.flatMap(key => {
    const material = materials.find(candidate => candidate.id === key.id);
    return material ? [{ ...key, secret: material.secret, passphrase: material.passphrase }] : [];
  });
}

export async function saveGlobalSshKey(
  keys: GlobalSshKeyMaterial[],
  input: SaveGlobalSshKeyInput,
): Promise<GlobalSshKeyMaterial[]> {
  const now = new Date().toISOString();
  const next: GlobalSshKeyMaterial[] = [
    ...keys,
    {
      id: createGlobalSshKeyId(),
      name: input.name.trim(),
      fingerprint: input.fingerprint,
      keyType: input.keyType,
      secret: input.secret,
      passphrase: input.passphrase,
      createdAt: now,
      updatedAt: now,
    },
  ].sort((left, right) => left.name.localeCompare(right.name));
  await replaceGlobalSshKeys(next);
  return next;
}

export async function deleteGlobalSshKey(
  keys: GlobalSshKeyMaterial[],
  id: string,
): Promise<GlobalSshKeyMaterial[]> {
  const next = keys.filter(key => key.id !== id);
  await replaceGlobalSshKeys(next);
  return next;
}

function createGlobalSshKeyId(): string {
  return `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

async function replaceGlobalSshKeys(keys: GlobalSshKeyMaterial[]): Promise<void> {
  const operation = keychainMutation.then(async () => {
    const materials: StoredKeyMaterial[] = keys.map(key => ({
      id: key.id,
      secret: key.secret,
      passphrase: key.passphrase,
    }));
    if (materials.length > 0) {
      await Keychain.setGenericPassword('global-ssh-keychain', JSON.stringify(materials), {
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        service: GLOBAL_SSH_KEYCHAIN_SERVICE,
      });
    } else {
      await Keychain.resetGenericPassword({ service: GLOBAL_SSH_KEYCHAIN_SERVICE });
    }
    const metadata: GlobalSshKey[] = keys.map(({ secret: _secret, passphrase: _passphrase, ...key }) => key);
    await AsyncStorage.setItem(GLOBAL_SSH_KEYS_STORAGE_KEY, JSON.stringify(metadata));
  });
  keychainMutation = operation.catch(() => undefined);
  await operation;
}

function parseMaterials(value: string | null): StoredKeyMaterial[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is StoredKeyMaterial => Boolean(
      entry
      && typeof entry === 'object'
      && typeof entry.id === 'string'
      && typeof entry.secret === 'string'
      && typeof entry.passphrase === 'string',
    ));
  } catch {
    return [];
  }
}

function isGlobalSshKey(value: unknown): value is GlobalSshKey {
  if (!value || typeof value !== 'object') return false;
  const key = value as Partial<GlobalSshKey>;
  return Boolean(
    key.id
    && typeof key.name === 'string'
    && typeof key.fingerprint === 'string'
    && typeof key.keyType === 'string'
    && typeof key.createdAt === 'string'
    && typeof key.updatedAt === 'string',
  );
}
