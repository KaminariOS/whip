import AsyncStorage from '@react-native-async-storage/async-storage';
import SSHClient from 'react-native-whip-ssh';

import { createSecureId } from '../lib/secureId';
import type { KnownHost } from '../types';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

export const KNOWN_HOSTS_STORAGE_KEY = 'herdr.known-hosts.v1';
export const UNKNOWN_HOST_KEY_PREFIX = 'E_HOST_KEY_UNKNOWN:';
export const CHANGED_HOST_KEY_PREFIX = 'E_HOST_KEY_CHANGED:';

export interface UnknownHostKeyChallenge {
  host: string;
  port: number;
  keyType: string;
  publicKey: string;
  fingerprint: string;
}

let knownHostsMutation = Promise.resolve();

export async function loadKnownHosts(): Promise<KnownHost[]> {
  let value: string | null;
  try {
    value = await AsyncStorage.getItem(KNOWN_HOSTS_STORAGE_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'known-hosts',
      storageKey: KNOWN_HOSTS_STORAGE_KEY,
      phase: 'startup',
      operation: 'getItem',
      fallbackUsed: 'empty-known-hosts',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  return knownHostsFromStorage(value);
}

export function knownHostsFromStorage(value: string | null): KnownHost[] {
  const hosts = parseKnownHosts(value);
  configureNativeKnownHosts(hosts);
  return hosts;
}

export async function trustKnownHost(
  hosts: KnownHost[],
  challenge: UnknownHostKeyChallenge,
): Promise<KnownHost[]> {
  const normalizedHost = normalizeHost(challenge.host);
  const normalizedPublicKey = normalizePublicKey(challenge.keyType, challenge.publicKey);
  const normalizedHosts = hosts.map(entry => {
    const publicKey = normalizePublicKey(entry.keyType, entry.publicKey);
    return publicKey === entry.publicKey ? entry : { ...entry, publicKey };
  });
  const duplicate = normalizedHosts.some(entry => (
    normalizeHost(entry.host) === normalizedHost
    && entry.port === challenge.port
    && entry.keyType === challenge.keyType
    && entry.publicKey === normalizedPublicKey
  ));
  if (duplicate) {
    if (normalizedHosts.some((entry, index) => entry !== hosts[index])) {
      await replaceKnownHosts(normalizedHosts);
    } else {
      configureNativeKnownHosts(normalizedHosts);
    }
    return normalizedHosts;
  }

  const next = [
    ...normalizedHosts,
    {
      id: createSecureId('known-host'),
      host: normalizedHost,
      port: challenge.port,
      keyType: challenge.keyType,
      publicKey: normalizedPublicKey,
      fingerprint: challenge.fingerprint,
      createdAt: new Date().toISOString(),
    },
  ].sort(compareKnownHosts);
  await replaceKnownHosts(next);
  return next;
}

export async function deleteKnownHost(hosts: KnownHost[], id: string): Promise<KnownHost[]> {
  const next = hosts.filter(entry => entry.id !== id);
  await replaceKnownHosts(next);
  return next;
}

export function parseUnknownHostKey(error: unknown): UnknownHostKeyChallenge | null {
  const parsed = structuredHostKeyPayload(error, 'HOST_KEY_UNKNOWN')
    || parseHostKeyPayload(
      error instanceof Error ? error.message : String(error),
      UNKNOWN_HOST_KEY_PREFIX,
    );
  if (
    !parsed
    || typeof parsed.keyType !== 'string'
    || typeof parsed.publicKey !== 'string'
    || typeof parsed.fingerprint !== 'string'
  ) {
    return null;
  }
  return {
    host: parsed.host,
    port: parsed.port,
    keyType: parsed.keyType,
    publicKey: parsed.publicKey,
    fingerprint: parsed.fingerprint,
  };
}

export function hostKeyErrorHost(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  const parsed = structuredHostKeyPayload(error, 'HOST_KEY_UNKNOWN')
    || structuredHostKeyPayload(error, 'HOST_KEY_CHANGED')
    || parseHostKeyPayload(text, UNKNOWN_HOST_KEY_PREFIX)
    || parseHostKeyPayload(text, CHANGED_HOST_KEY_PREFIX);
  if (!parsed) return null;
  return parsed.port === 22 ? parsed.host : `[${parsed.host}]:${parsed.port}`;
}

function structuredHostKeyPayload(
  error: unknown,
  expectedCode: 'HOST_KEY_UNKNOWN' | 'HOST_KEY_CHANGED',
): { host: string; port: number; [key: string]: unknown } | null {
  if (!error || typeof error !== 'object' || !('code' in error) || !('details' in error)) {
    return null;
  }
  const candidate = error as { code?: unknown; details?: unknown };
  if (candidate.code !== expectedCode || !candidate.details || typeof candidate.details !== 'object') {
    return null;
  }
  const details = candidate.details as Record<string, unknown>;
  if (
    typeof details.host !== 'string'
    || typeof details.port !== 'number'
    || !Number.isInteger(details.port)
    || details.port < 1
    || details.port > 65535
  ) {
    return null;
  }
  return {
    ...details,
    host: normalizeHost(details.host),
    port: details.port,
  };
}

function parseHostKeyPayload(
  text: string,
  prefix: string,
): { host: string; port: number; [key: string]: unknown } | null {
  const prefixIndex = text.indexOf(prefix);
  if (prefixIndex < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(prefixIndex + prefix.length));
    if (
      !parsed
      || typeof parsed !== 'object'
      || typeof parsed.host !== 'string'
      || typeof parsed.port !== 'number'
      || !Number.isInteger(parsed.port)
      || parsed.port < 1
      || parsed.port > 65535
    ) {
      return null;
    }
    return {
      ...parsed,
      host: normalizeHost(parsed.host),
      port: parsed.port,
    };
  } catch {
    return null;
  }
}

export function serializeKnownHosts(hosts: KnownHost[]): string {
  return hosts
    .map(entry => (
      `${knownHostAlias(entry.host, entry.port)} ${entry.keyType} ${normalizePublicKey(entry.keyType, entry.publicKey)}`
    ))
    .join('\n');
}

function configureNativeKnownHosts(hosts: KnownHost[]): void {
  SSHClient.setKnownHosts(serializeKnownHosts(hosts));
}

async function replaceKnownHosts(hosts: KnownHost[]): Promise<void> {
  const operation = knownHostsMutation.then(async () => {
    try {
      await AsyncStorage.setItem(KNOWN_HOSTS_STORAGE_KEY, JSON.stringify(hosts));
    } catch (error) {
      recordStorageDiagnostic('error', 'storage-write-failed', {
        store: 'known-hosts',
        storageKey: KNOWN_HOSTS_STORAGE_KEY,
        phase: 'persistence',
        operation: 'setItem',
        ...storageErrorDetails(error),
      });
      throw error;
    }
    configureNativeKnownHosts(hosts);
  });
  knownHostsMutation = operation.catch(() => undefined);
  await operation;
}

function parseKnownHosts(value: string | null): KnownHost[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new TypeError('Stored known hosts must be an array');
    return parsed.filter(isKnownHost).sort(compareKnownHosts);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'known-hosts',
      storageKey: KNOWN_HOSTS_STORAGE_KEY,
      phase: 'startup',
      operation: 'parse',
      fallbackUsed: 'empty-known-hosts',
      ...storageParseErrorDetails(error),
    });
    return [];
  }
}

function isKnownHost(value: unknown): value is KnownHost {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<KnownHost>;
  return Boolean(
    entry.id
    && typeof entry.host === 'string'
    && typeof entry.port === 'number'
    && Number.isInteger(entry.port)
    && entry.port > 0
    && entry.port <= 65535
    && typeof entry.keyType === 'string'
    && typeof entry.publicKey === 'string'
    && typeof entry.fingerprint === 'string'
    && typeof entry.createdAt === 'string',
  );
}

function knownHostAlias(host: string, port: number): string {
  const normalized = normalizeHost(host);
  return port === 22 ? normalized : `[${normalized}]:${port}`;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function normalizePublicKey(keyType: string, publicKey: string): string {
  const fields = publicKey.trim().split(/\s+/);
  return fields[0] === keyType && fields.length > 1 ? fields[1] : fields[0];
}

function compareKnownHosts(left: KnownHost, right: KnownHost): number {
  return left.host.localeCompare(right.host)
    || left.port - right.port
    || left.keyType.localeCompare(right.keyType);
}
