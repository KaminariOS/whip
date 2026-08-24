import type { ConnectionProfile } from '../types';

interface CachedHerdrSocketPath {
  hostId: string;
  fingerprint: string;
  socketPath: string;
}

interface PersistedHerdrSocketPaths {
  entries: CachedHerdrSocketPath[];
}

const cachedPaths = new Map<string, CachedHerdrSocketPath>();
let changeListener: ((serialized: string) => void) | null = null;

function profileFingerprint(profile: ConnectionProfile): string {
  return [
    profile.host.trim(),
    profile.port.trim(),
    profile.username.trim(),
    profile.sessionName.trim(),
  ].join('\n');
}

function validEntry(value: unknown): value is CachedHerdrSocketPath {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CachedHerdrSocketPath>;
  return typeof entry.hostId === 'string'
    && Boolean(entry.hostId)
    && typeof entry.fingerprint === 'string'
    && typeof entry.socketPath === 'string'
    && entry.socketPath.startsWith('/');
}

function notifyChanged(): void {
  changeListener?.(JSON.stringify({
    entries: [...cachedPaths.values()],
  } satisfies PersistedHerdrSocketPaths));
}

export function hydrateHerdrSocketPathCache(value: string | null): void {
  cachedPaths.clear();
  if (!value) return;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedHerdrSocketPaths>;
    if (!Array.isArray(parsed.entries)) return;
    for (const entry of parsed.entries) {
      if (validEntry(entry)) cachedPaths.set(entry.hostId, entry);
    }
  } catch {
    // A malformed performance cache is equivalent to a cold start.
  }
}

export function setHerdrSocketPathCacheChangeListener(
  listener: ((serialized: string) => void) | null,
): void {
  changeListener = listener;
}

export function cachedHerdrSocketPath(profile: ConnectionProfile): string | null {
  const cached = cachedPaths.get(profile.id);
  if (!cached) return null;
  if (cached.fingerprint === profileFingerprint(profile)) return cached.socketPath;
  cachedPaths.delete(profile.id);
  notifyChanged();
  return null;
}

export function rememberHerdrSocketPath(profile: ConnectionProfile, socketPath: string): void {
  if (!socketPath.startsWith('/')) return;
  cachedPaths.set(profile.id, {
    hostId: profile.id,
    fingerprint: profileFingerprint(profile),
    socketPath,
  });
  notifyChanged();
}

export function forgetHerdrSocketPath(profile: ConnectionProfile, socketPath: string): void {
  const cached = cachedPaths.get(profile.id);
  if (cached?.socketPath !== socketPath) return;
  cachedPaths.delete(profile.id);
  notifyChanged();
}

/** Clears only process memory. Persisted data is reloaded explicitly at startup. */
export function clearHerdrSocketPathCache(): void {
  cachedPaths.clear();
}
