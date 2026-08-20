import { shellQuote } from './shell';

export const REMOTE_GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const REMOTE_GIT_DIFF_MAX_ROWS = 12_000;

export interface RemoteGitRepository {
  root: string;
  hasHead: boolean;
}

export interface RemoteGitStatusEntry {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath: string | null;
}

export type RemoteGitDiffRowKind =
  | 'header'
  | 'hunk'
  | 'context'
  | 'addition'
  | 'deletion'
  | 'meta';

export interface RemoteGitDiffRow {
  key: string;
  kind: RemoteGitDiffRowKind;
  content: string;
  marker: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface RemoteGitDiff {
  kind: 'text' | 'binary' | 'empty';
  rows: RemoteGitDiffRow[];
  truncated: boolean;
}

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

const REPOSITORY_ROOT_PREFIX = 'WHIP_GIT_ROOT:';
const REPOSITORY_HEAD_PREFIX = 'WHIP_GIT_HEAD:';

export function remoteGitRepositoryCommand(path: string): string {
  const script = [
    'if ! command -v git >/dev/null 2>&1; then exit 0; fi',
    `repo_root=$(git -C ${shellQuote(
      path,
    )} rev-parse --show-toplevel 2>/dev/null) || exit 0`,
    'if git -C "$repo_root" rev-parse --verify HEAD >/dev/null 2>&1; then has_head=1; else has_head=0; fi',
    `printf '${REPOSITORY_ROOT_PREFIX}%s\\n${REPOSITORY_HEAD_PREFIX}%s\\n' "$repo_root" "$has_head"`,
  ].join('\n');
  return `sh -c ${shellQuote(script)}`;
}

export function parseRemoteGitRepository(
  output: string,
): RemoteGitRepository | null {
  const lines = output.split(/\r?\n/);
  const root = lines
    .find(line => line.startsWith(REPOSITORY_ROOT_PREFIX))
    ?.slice(REPOSITORY_ROOT_PREFIX.length);
  if (!root) return null;
  const head = lines
    .find(line => line.startsWith(REPOSITORY_HEAD_PREFIX))
    ?.slice(REPOSITORY_HEAD_PREFIX.length);
  return { root, hasHead: head === '1' };
}

export function remoteGitStatusCommand(root: string): string {
  return [
    'git',
    '-C',
    shellQuote(root),
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ].join(' ');
}

export function parseRemoteGitStatus(output: string): RemoteGitStatusEntry[] {
  const records = output.split('\0');
  const entries: RemoteGitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const renamed = /[RC]/.test(indexStatus) || /[RC]/.test(worktreeStatus);
    entries.push({
      indexStatus,
      worktreeStatus,
      path: record.slice(3),
      originalPath: renamed ? records[++index] || null : null,
    });
  }
  return entries.sort((first, second) =>
    first.path.localeCompare(second.path, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}

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

export function remoteGitDiffCommand(
  repository: RemoteGitRepository,
  status: RemoteGitStatusEntry,
): string {
  const common = '--no-ext-diff --no-textconv --no-color --unified=3';
  const path = shellQuote(status.path);
  const diff = isRemoteGitEntryUntracked(status)
    ? `git -C ${shellQuote(
        repository.root,
      )} diff --no-index ${common} -- /dev/null ${path} 2>/dev/null`
    : repository.hasHead
    ? `git -C ${shellQuote(repository.root)} diff ${common} HEAD -- ${path}`
    : `git -C ${shellQuote(
        repository.root,
      )} diff ${common} --cached -- ${path}`;
  return `${diff} | head -c ${REMOTE_GIT_DIFF_MAX_BYTES + 1}`;
}

export function parseRemoteGitDiff(output: string): RemoteGitDiff {
  const byteLimited = output.length > REMOTE_GIT_DIFF_MAX_BYTES;
  const text = byteLimited
    ? output.slice(0, REMOTE_GIT_DIFF_MAX_BYTES)
    : output;
  if (!text.trim()) return { kind: 'empty', rows: [], truncated: false };
  if (/^(?:Binary files .+ differ|GIT binary patch)$/m.test(text)) {
    return { kind: 'binary', rows: [], truncated: byteLimited };
  }

  const rows: RemoteGitDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let rowLimited = false;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (rows.length >= REMOTE_GIT_DIFF_MAX_ROWS) {
      rowLimited = true;
      break;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push(diffRow(rows.length, 'hunk', line, '', null, null));
      continue;
    }
    if (!inHunk) {
      rows.push(diffRow(rows.length, 'header', line, '', null, null));
      continue;
    }
    if (line.startsWith('+')) {
      rows.push(
        diffRow(rows.length, 'addition', line.slice(1), '+', null, newLine),
      );
      newLine += 1;
    } else if (line.startsWith('-')) {
      rows.push(
        diffRow(rows.length, 'deletion', line.slice(1), '-', oldLine, null),
      );
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      rows.push(
        diffRow(rows.length, 'context', line.slice(1), ' ', oldLine, newLine),
      );
      oldLine += 1;
      newLine += 1;
    } else {
      rows.push(diffRow(rows.length, 'meta', line, '', null, null));
    }
  }

  return {
    kind: 'text',
    rows,
    truncated: byteLimited || rowLimited,
  };
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

export function absoluteRemoteGitPath(
  root: string,
  relativePath: string,
): string {
  return `${root.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}

function diffRow(
  index: number,
  kind: RemoteGitDiffRowKind,
  content: string,
  marker: string,
  oldLine: number | null,
  newLine: number | null,
): RemoteGitDiffRow {
  return { key: `${index}-${kind}`, kind, content, marker, oldLine, newLine };
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
