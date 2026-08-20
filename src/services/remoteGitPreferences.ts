import AsyncStorage from '@react-native-async-storage/async-storage';

export const REMOTE_GIT_PREFERENCES_KEY = 'whip.remote-git-mode.v1';
export const REMOTE_GIT_TREE_PREFERENCES_KEY = 'whip.remote-git-tree.v1';
const MAX_REPOSITORIES = 100;
const MAX_COLLAPSED_PATHS = 500;

interface StoredRepositoryMode {
  hostId: string;
  root: string;
  updatedAt: number;
}

interface StoredRepositoryTree {
  hostId: string;
  root: string;
  collapsedPaths: string[];
  updatedAt: number;
}

export async function loadRemoteGitMode(
  hostId: string,
  root: string,
): Promise<boolean> {
  const entries = await loadEntries();
  return entries.some(entry => entry.hostId === hostId && entry.root === root);
}

export async function saveRemoteGitMode(
  hostId: string,
  root: string,
  enabled: boolean,
): Promise<void> {
  const entries = (await loadEntries()).filter(
    entry => entry.hostId !== hostId || entry.root !== root,
  );
  if (enabled) entries.unshift({ hostId, root, updatedAt: Date.now() });
  await AsyncStorage.setItem(
    REMOTE_GIT_PREFERENCES_KEY,
    JSON.stringify(entries.slice(0, MAX_REPOSITORIES)),
  );
}

export async function loadRemoteGitCollapsedPaths(
  hostId: string,
  root: string,
): Promise<string[]> {
  const entries = await loadTreeEntries();
  return (
    entries.find(entry => entry.hostId === hostId && entry.root === root)
      ?.collapsedPaths || []
  );
}

export async function saveRemoteGitCollapsedPaths(
  hostId: string,
  root: string,
  collapsedPaths: readonly string[],
): Promise<void> {
  const entries = (await loadTreeEntries()).filter(
    entry => entry.hostId !== hostId || entry.root !== root,
  );
  entries.unshift({
    hostId,
    root,
    collapsedPaths: [...new Set(collapsedPaths)].slice(0, MAX_COLLAPSED_PATHS),
    updatedAt: Date.now(),
  });
  await AsyncStorage.setItem(
    REMOTE_GIT_TREE_PREFERENCES_KEY,
    JSON.stringify(entries.slice(0, MAX_REPOSITORIES)),
  );
}

async function loadEntries(): Promise<StoredRepositoryMode[]> {
  try {
    const value = await AsyncStorage.getItem(REMOTE_GIT_PREFERENCES_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is StoredRepositoryMode =>
          entry &&
          typeof entry.hostId === 'string' &&
          typeof entry.root === 'string' &&
          typeof entry.updatedAt === 'number',
      )
      .sort((first, second) => second.updatedAt - first.updatedAt);
  } catch {
    return [];
  }
}

async function loadTreeEntries(): Promise<StoredRepositoryTree[]> {
  try {
    const value = await AsyncStorage.getItem(REMOTE_GIT_TREE_PREFERENCES_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is StoredRepositoryTree =>
          entry &&
          typeof entry.hostId === 'string' &&
          typeof entry.root === 'string' &&
          Array.isArray(entry.collapsedPaths) &&
          entry.collapsedPaths.every(
            (path: unknown) => typeof path === 'string',
          ) &&
          typeof entry.updatedAt === 'number',
      )
      .sort((first, second) => second.updatedAt - first.updatedAt);
  } catch {
    return [];
  }
}
