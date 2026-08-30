import type { ConnectionProfile, HostProfile } from '../types';
import {
  NativeHostProfileStore,
  type HostProfileStoreProjection,
} from 'react-native-whip-ssh';
import { createSecureId } from './secureId';

export const HOSTS_STORAGE_KEY = 'herdr.hosts.v2';
export const LEGACY_PROFILE_KEY = 'herdr.connection.v1';
export const LEGACY_CREDENTIAL_SERVICE = 'io.github.kaminarios.whip.ssh';
export const HOST_CREDENTIAL_SERVICE_PREFIX = 'io.github.kaminarios.whip.ssh.host.';
export const DEFAULT_SSH_PORT = '22';
export const DEFAULT_HERDR_COMMAND = 'herdr';
const hostProfileStore = new NativeHostProfileStore();

export const emptyConnectionProfile = (): ConnectionProfile => {
  const now = new Date().toISOString();
  return {
    id: createHostId(),
    name: '',
    host: '',
    port: DEFAULT_SSH_PORT,
    username: '',
    jumpHostId: undefined,
    forwardAgent: false,
    authMode: 'password',
    secret: '',
    passphrase: '',
    herdrCommand: DEFAULT_HERDR_COMMAND,
    herdrSocketPath: '',
    sessionName: '',
    createdAt: now,
    updatedAt: now,
  };
};

export function createHostId(): string {
  return createSecureId('host');
}

export function hostCredentialService(id: string): string {
  return `${HOST_CREDENTIAL_SERVICE_PREFIX}${id}`;
}

export function hostDisplayName(profile: Pick<HostProfile, 'name' | 'host' | 'username'>): string {
  if (profile.name.trim()) return profile.name.trim();
  return profile.host.trim() || 'New host';
}

export function legacyHostName(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return '';
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    return trimmed.split('.')[0];
  }
  return trimmed;
}

export function toHostProfile(profile: ConnectionProfile, previous?: HostProfile): HostProfile {
  const now = new Date().toISOString();
  return hostProfileStore.normalizeProfile({
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    jumpHostId: profile.jumpHostId,
    forwardAgent: Boolean(profile.forwardAgent),
    authMode: profile.authMode,
    herdrCommand: profile.herdrCommand,
    herdrSocketPath: profile.herdrSocketPath ?? '',
    sessionName: profile.sessionName,
    createdAt: previous?.createdAt || profile.createdAt || now,
    updatedAt: now,
    lastConnectedAt: previous?.lastConnectedAt || profile.lastConnectedAt,
  }, previous?.createdAt, now);
}

export function upsertHost(hosts: HostProfile[], next: HostProfile): HostProfile[] {
  return prepareHostUpsert(hosts, next).hosts;
}

export function sortHosts(hosts: HostProfile[]): HostProfile[] {
  return hostProfileStore.hydrate(JSON.stringify(hosts)).hosts;
}

export function parseHosts(
  value: string | null,
  onParseError?: (error: unknown) => void,
): HostProfile[] {
  if (!value) {
    return hostProfileStore.hydrate().hosts;
  }
  try {
    return hostProfileStore.hydrate(value).hosts;
  } catch (error) {
    onParseError?.(error);
    return hostProfileStore.hydrate().hosts;
  }
}

export function resolveJumpHostChain(
  hosts: HostProfile[],
  profile: Pick<HostProfile, 'id' | 'jumpHostId'>,
): HostProfile[] {
  hostProfileStore.hydrate(JSON.stringify(hosts));
  return hostProfileStore.resolveJumpChain(
    profile.id,
    profile.jumpHostId,
  );
}

export function jumpHostCandidates(hosts: HostProfile[], profileId: string): HostProfile[] {
  hostProfileStore.hydrate(JSON.stringify(hosts));
  return hostProfileStore.jumpCandidates(profileId);
}

export function migrateLegacyProfile(
  value: string | null,
  onParseError?: (error: unknown) => void,
): ConnectionProfile | null {
  if (!value) return null;
  try {
    const now = new Date().toISOString();
    const migrated = hostProfileStore.migrateLegacy(value, now);
    return migrated ? { ...migrated, secret: '', passphrase: '' } : null;
  } catch (error) {
    onParseError?.(error);
    return null;
  }
}

export function prepareHostUpsert(
  hosts: HostProfile[],
  next: HostProfile,
): HostProfileStoreProjection {
  hydrateHostProfiles(hosts);
  return hostProfileStore.upsert(
    {
      ...next,
      forwardAgent: Boolean(next.forwardAgent),
      herdrSocketPath: next.herdrSocketPath ?? '',
    },
    next.updatedAt,
  );
}

export function prepareHostDisconnected(
  hosts: HostProfile[],
  id: string,
  now: string,
): HostProfileStoreProjection {
  hydrateHostProfiles(hosts);
  return hostProfileStore.markDisconnected(id, now);
}

export function prepareHostRemoval(
  hosts: HostProfile[],
  id: string,
  now: string,
): HostProfileStoreProjection {
  hydrateHostProfiles(hosts);
  return hostProfileStore.remove(id, now);
}

export function hydrateHostProfiles(
  hosts: readonly HostProfile[],
): HostProfileStoreProjection {
  return hostProfileStore.hydrate(JSON.stringify(hosts));
}
