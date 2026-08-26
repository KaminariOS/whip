import type { RuntimeGitDiff, RuntimeGitRepository, RuntimeGitStatusEntry } from 'react-native-whip-ssh';

export type RemoteGitRepository = RuntimeGitRepository;
export type RemoteGitStatusEntry = RuntimeGitStatusEntry;
export type RemoteGitDiff = RuntimeGitDiff;
export type RemoteGitDiffRow = RuntimeGitDiff['rows'][number];

export interface RemoteGitTreeDirectoryRow {
  kind: 'directory';
  key: string;
  path: string;
  name: string;
  depth: number;
  changeCount: number;
}

export interface RemoteGitTreeFileRow {
  kind: 'file';
  key: string;
  name: string;
  depth: number;
  status: RemoteGitStatusEntry;
}

export type RemoteGitTreeRow = RemoteGitTreeDirectoryRow | RemoteGitTreeFileRow;

export function buildRemoteGitTreeRows(
  statuses: readonly RemoteGitStatusEntry[],
  collapsedPaths: ReadonlySet<string>,
): RemoteGitTreeRow[] {
  const root = gitTreeDirectory('', '');
  for (const status of statuses) {
    const parts = status.path.split('/');
    const name = parts.pop() || status.path;
    let directory = root;
    for (const part of parts) {
      const path = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = gitTreeDirectory(path, part);
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ name, status });
  }

  countGitTreeChanges(root);
  const rows: RemoteGitTreeRow[] = [];
  appendGitTreeRows(root, 0, collapsedPaths, rows);
  return rows;
}

export function remoteGitStatusLabel(status: RemoteGitStatusEntry): string {
  if (isRemoteGitEntryUntracked(status)) return '??';
  const codes = [status.indexStatus, status.worktreeStatus].filter(
    code => code !== ' ',
  );
  return codes.join('') || 'M';
}

export function isRemoteGitEntryUntracked(
  status: RemoteGitStatusEntry,
): boolean {
  return status.indexStatus === '?' && status.worktreeStatus === '?';
}

export function isRemoteGitEntryDeleted(status: RemoteGitStatusEntry): boolean {
  return status.indexStatus === 'D' || status.worktreeStatus === 'D';
}

interface MutableGitTreeDirectory {
  path: string;
  name: string;
  changeCount: number;
  directories: Map<string, MutableGitTreeDirectory>;
  files: Array<{ name: string; status: RemoteGitStatusEntry }>;
}

function gitTreeDirectory(path: string, name: string): MutableGitTreeDirectory {
  return {
    path,
    name,
    changeCount: 0,
    directories: new Map(),
    files: [],
  };
}

function countGitTreeChanges(directory: MutableGitTreeDirectory): number {
  directory.changeCount = directory.files.length;
  for (const child of directory.directories.values()) {
    directory.changeCount += countGitTreeChanges(child);
  }
  return directory.changeCount;
}

function appendGitTreeRows(
  directory: MutableGitTreeDirectory,
  depth: number,
  collapsedPaths: ReadonlySet<string>,
  rows: RemoteGitTreeRow[],
): void {
  const directories = [...directory.directories.values()].sort(
    (first, second) => compareGitTreeNames(first.name, second.name),
  );
  for (const child of directories) {
    rows.push({
      kind: 'directory',
      key: `directory:${child.path}`,
      path: child.path,
      name: child.name,
      depth,
      changeCount: child.changeCount,
    });
    if (!collapsedPaths.has(child.path)) {
      appendGitTreeRows(child, depth + 1, collapsedPaths, rows);
    }
  }

  const files = [...directory.files].sort((first, second) =>
    compareGitTreeNames(first.name, second.name),
  );
  for (const file of files) {
    rows.push({
      kind: 'file',
      key: `file:${file.status.indexStatus}${file.status.worktreeStatus}:${file.status.path}`,
      name: file.name,
      depth,
      status: file.status,
    });
  }
}

function compareGitTreeNames(first: string, second: string): number {
  return first.localeCompare(second, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}
