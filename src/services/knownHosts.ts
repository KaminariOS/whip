import AsyncStorage from '@react-native-async-storage/async-storage';
import { setTrustedHostKeys } from 'react-native-whip-ssh';

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

export type KnownHostsLoadState =
  | { status: 'loading' }
  | { status: 'loaded'; hosts: KnownHost[] }
  | { status: 'failed'; error: unknown };

export class KnownHostsUnavailableError extends Error {
  constructor() {
    super('Known SSH hosts must be loaded successfully before they can be changed');
    this.name = 'KnownHostsUnavailableError';
  }
}

let knownHostsMutation = Promise.resolve();
let knownHostsState: KnownHostsLoadState = { status: 'loading' };

export async function loadKnownHosts(): Promise<KnownHostsLoadState> {
  knownHostsState = { status: 'loading' };
  let value: string | null;
  try {
    value = await AsyncStorage.getItem(KNOWN_HOSTS_STORAGE_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'known-hosts',
      storageKey: KNOWN_HOSTS_STORAGE_KEY,
      phase: 'startup',
      operation: 'getItem',
      fallbackUsed: 'preserved-native-known-hosts',
      ...storageErrorDetails(error),
    });
    knownHostsState = { status: 'failed', error };
    return knownHostsState;
  }
  return knownHostsFromStorage(value);
}

export function knownHostsFromStorage(value: string | null): KnownHostsLoadState {
  try {
    const hosts = parseKnownHosts(value);
    configureNativeKnownHosts(hosts);
    knownHostsState = { status: 'loaded', hosts };
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'known-hosts',
      storageKey: KNOWN_HOSTS_STORAGE_KEY,
      phase: 'startup',
      operation: 'parse',
      fallbackUsed: 'preserved-native-known-hosts',
      ...storageParseErrorDetails(error),
    });
    knownHostsState = { status: 'failed', error };
  }
  return knownHostsState;
}

export async function trustKnownHost(
  challenge: UnknownHostKeyChallenge,
): Promise<KnownHost[]> {
  return mutateKnownHosts(hosts => {
    const duplicate = hosts.some(entry => (
      entry.host === challenge.host
      && entry.port === challenge.port
      && entry.keyType === challenge.keyType
      && entry.fingerprint === challenge.fingerprint
    ));
    if (duplicate) return hosts;

    return [
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
  });
}

export async function deleteKnownHost(id: string): Promise<KnownHost[]> {
  return mutateKnownHosts(hosts => hosts.filter(entry => entry.id !== id));
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
  setTrustedHostKeys(hosts.map(({ host, port, keyType, publicKey }) => ({
    host,
    port,
    keyType,
    publicKey,
  })));
}

async function mutateKnownHosts(
  update: (hosts: KnownHost[]) => KnownHost[],
): Promise<KnownHost[]> {
  const operation = knownHostsMutation.then(async () => {
    if (knownHostsState.status !== 'loaded') {
      throw new KnownHostsUnavailableError();
    }
    const previousHosts = knownHostsState.hosts;
    const hosts = update(previousHosts);
    if (hosts === previousHosts) return previousHosts;

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
    knownHostsState = { status: 'loaded', hosts };
    return hosts;
  });
  knownHostsMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function parseKnownHosts(value: string | null): KnownHost[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new TypeError('Stored known hosts must be an array');
  }
  const entries = parsed.filter(isKnownHost);
  const invalidIndex = parsed.findIndex(entry => !isKnownHost(entry));
  if (invalidIndex !== -1) {
    throw new TypeError(`Stored known host at index ${invalidIndex} is malformed`);
  }
  return entries.sort(compareKnownHosts);
}

function isKnownHost(value: unknown): value is KnownHost {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<KnownHost>;
  return (
    typeof entry.id === 'string'
    && entry.id.length > 0
    && typeof entry.host === 'string'
    && entry.host.trim().length > 0
    && typeof entry.port === 'number'
    && Number.isInteger(entry.port)
    && entry.port > 0
    && entry.port <= 65535
    && typeof entry.keyType === 'string'
    && entry.keyType.length > 0
    && typeof entry.publicKey === 'string'
    && entry.publicKey.length > 0
    && typeof entry.fingerprint === 'string'
    && entry.fingerprint.length > 0
    && typeof entry.createdAt === 'string'
    && entry.createdAt.length > 0
  );
}

function compareKnownHosts(left: KnownHost, right: KnownHost): number {
  return left.host.localeCompare(right.host)
    || left.port - right.port
    || left.keyType.localeCompare(right.keyType);
}
