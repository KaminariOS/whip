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
  const duplicate = hosts.some(entry => (
    entry.host === challenge.host
    && entry.port === challenge.port
    && entry.keyType === challenge.keyType
    && entry.fingerprint === challenge.fingerprint
  ));
  if (duplicate) {
    configureNativeKnownHosts(hosts);
    return hosts;
  }

  const next = [
    ...hosts,
    {
      id: createSecureId('known-host'),
      host: challenge.host,
      port: challenge.port,
      keyType: challenge.keyType,
      publicKey: challenge.publicKey,
      fingerprint: challenge.fingerprint,
      createdAt: new Date().toISOString(),
    },
  ].sort(compareKnownHosts);
  await replaceKnownHosts(next, hosts);
  return next;
}

export async function deleteKnownHost(hosts: KnownHost[], id: string): Promise<KnownHost[]> {
  const next = hosts.filter(entry => entry.id !== id);
  await replaceKnownHosts(next, hosts);
  return next;
}

export function parseUnknownHostKey(error: unknown): UnknownHostKeyChallenge | null {
  const parsed = structuredHostKeyPayload(error, 'HOST_KEY_UNKNOWN');
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
  const parsed = structuredHostKeyPayload(error, 'HOST_KEY_UNKNOWN')
    || structuredHostKeyPayload(error, 'HOST_KEY_CHANGED');
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
  ) {
    return null;
  }
  return {
    ...details,
    host: details.host,
    port: details.port,
  };
}

function configureNativeKnownHosts(hosts: KnownHost[]): void {
  SSHClient.setTrustedHostKeys(hosts.map(({ host, port, keyType, publicKey }) => ({
    host,
    port,
    keyType,
    publicKey,
  })));
}

async function replaceKnownHosts(hosts: KnownHost[], previousHosts: KnownHost[]): Promise<void> {
  const operation = knownHostsMutation.then(async () => {
    // Rust validates the protocol material before it can become durable.
    configureNativeKnownHosts(hosts);
    try {
      await AsyncStorage.setItem(KNOWN_HOSTS_STORAGE_KEY, JSON.stringify(hosts));
    } catch (error) {
      configureNativeKnownHosts(previousHosts);
      recordStorageDiagnostic('error', 'storage-write-failed', {
        store: 'known-hosts',
        storageKey: KNOWN_HOSTS_STORAGE_KEY,
        phase: 'persistence',
        operation: 'setItem',
        ...storageErrorDetails(error),
      });
      throw error;
    }
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

function compareKnownHosts(left: KnownHost, right: KnownHost): number {
  return left.host.localeCompare(right.host)
    || left.port - right.port
    || left.keyType.localeCompare(right.keyType);
}
