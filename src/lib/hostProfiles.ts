import type { ConnectionProfile, HostProfile } from '../types';
import { createSecureId } from './secureId';

export const HOSTS_STORAGE_KEY = 'herdr.hosts.v2';
export const LEGACY_PROFILE_KEY = 'herdr.connection.v1';
export const LEGACY_CREDENTIAL_SERVICE = 'io.github.kaminarios.whip.ssh';
export const HOST_CREDENTIAL_SERVICE_PREFIX = 'io.github.kaminarios.whip.ssh.host.';
export const DEFAULT_SSH_PORT = '22';
export const DEFAULT_HERDR_COMMAND = 'herdr';

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
  return {
    id: profile.id,
    name: profile.name.trim(),
    host: profile.host.trim(),
    port: profile.port.trim() || DEFAULT_SSH_PORT,
    username: profile.username.trim(),
    jumpHostId: profile.jumpHostId?.trim() || undefined,
    forwardAgent: profile.authMode === 'key' && Boolean(profile.forwardAgent),
    authMode: profile.authMode,
    herdrCommand: profile.herdrCommand.trim() || DEFAULT_HERDR_COMMAND,
    herdrSocketPath: profile.herdrSocketPath?.trim() || '',
    sessionName: profile.sessionName.trim(),
    createdAt: previous?.createdAt || profile.createdAt || now,
    updatedAt: now,
    lastConnectedAt: previous?.lastConnectedAt || profile.lastConnectedAt,
  };
}

export function upsertHost(hosts: HostProfile[], next: HostProfile): HostProfile[] {
  const found = hosts.some(host => host.id === next.id);
  const updated = found
    ? hosts.map(host => (host.id === next.id ? next : host))
    : [...hosts, next];
  return sortHosts(updated);
}

export function sortHosts(hosts: HostProfile[]): HostProfile[] {
  return [...hosts].sort((left, right) => {
    const leftUsed = left.lastConnectedAt || '';
    const rightUsed = right.lastConnectedAt || '';
    if (leftUsed !== rightUsed) return rightUsed.localeCompare(leftUsed);
    return hostDisplayName(left).localeCompare(hostDisplayName(right));
  });
}

export function parseHosts(
  value: string | null,
  onParseError?: (error: unknown) => void,
): HostProfile[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      onParseError?.(new TypeError('Stored host profiles must be an array'));
      return [];
    }
    return sortHosts(parsed.filter(isHostProfile).map(profile => {
      const host = { ...profile } as HostProfile & { rememberCredentials?: boolean };
      delete host.rememberCredentials;
      return {
        ...host,
        forwardAgent: host.authMode === 'key' && Boolean(host.forwardAgent),
      };
    }));
  } catch (error) {
    onParseError?.(error);
    return [];
  }
}

export function resolveJumpHostChain(
  hosts: HostProfile[],
  profile: Pick<HostProfile, 'id' | 'jumpHostId'>,
): HostProfile[] {
  const byId = new Map(hosts.map(host => [host.id, host]));
  const seen = new Set([profile.id]);
  const chain: HostProfile[] = [];
  let jumpHostId = profile.jumpHostId;

  while (jumpHostId) {
    if (seen.has(jumpHostId)) {
      throw new Error('Jump host configuration contains a cycle');
    }
    const jumpHost = byId.get(jumpHostId);
    if (!jumpHost) {
      throw new Error(`Jump host ${jumpHostId} no longer exists`);
    }
    seen.add(jumpHostId);
    chain.unshift(jumpHost);
    jumpHostId = jumpHost.jumpHostId;
  }

  return chain;
}

export function jumpHostCandidates(hosts: HostProfile[], profileId: string): HostProfile[] {
  return hosts.filter(candidate => {
    if (candidate.id === profileId) return false;
    try {
      resolveJumpHostChain(hosts, { id: profileId, jumpHostId: candidate.id });
      return true;
    } catch {
      return false;
    }
  });
}

export function migrateLegacyProfile(
  value: string | null,
  onParseError?: (error: unknown) => void,
): ConnectionProfile | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ConnectionProfile>;
    if (!parsed?.host || !parsed.username) {
      onParseError?.(new TypeError('Stored legacy host profile is invalid'));
      return null;
    }
    const now = new Date().toISOString();
    return {
      id: 'host-legacy-default',
      name: parsed.name?.trim() || legacyHostName(parsed.host),
      host: parsed.host,
      port: parsed.port || DEFAULT_SSH_PORT,
      username: parsed.username,
      jumpHostId: undefined,
      forwardAgent: false,
      authMode: parsed.authMode === 'key' ? 'key' : 'password',
      secret: '',
      passphrase: '',
      herdrCommand: parsed.herdrCommand || DEFAULT_HERDR_COMMAND,
      herdrSocketPath: parsed.herdrSocketPath || '',
      sessionName: parsed.sessionName || '',
      createdAt: now,
      updatedAt: now,
    };
  } catch (error) {
    onParseError?.(error);
    return null;
  }
}

function isHostProfile(value: unknown): value is HostProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<HostProfile>;
  return Boolean(
    profile.id &&
    typeof profile.name === 'string' &&
    profile.host &&
    profile.username &&
    (profile.authMode === 'password' || profile.authMode === 'key'),
  );
}
