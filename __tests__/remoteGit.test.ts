import {
  buildRemoteGitTreeRows,
  isRemoteGitEntryDeleted,
  isRemoteGitEntryUntracked,
  remoteGitStatusLabel,
  type RemoteGitStatusEntry,
} from '../src/lib/remoteGit';

const status = (path: string, overrides: Partial<RemoteGitStatusEntry> = {}): RemoteGitStatusEntry => ({
  indexStatus: ' ',
  worktreeStatus: 'M',
  path,
  originalPath: null,
  absolutePath: `/repo/${path}`,
  ...overrides,
});

describe('remote Git status presentation', () => {
  it('labels normalized Rust status records', () => {
    expect(remoteGitStatusLabel(status('modified.ts'))).toBe('M');
    expect(remoteGitStatusLabel(status('new.ts', { indexStatus: '?', worktreeStatus: '?' }))).toBe('??');
    expect(isRemoteGitEntryUntracked(status('new.ts', { indexStatus: '?', worktreeStatus: '?' }))).toBe(true);
    expect(isRemoteGitEntryDeleted(status('gone.ts', { worktreeStatus: 'D' }))).toBe(true);
  });
});

describe('remote Git status tree', () => {
  it('groups directories before files and tracks nesting and change counts', () => {
    const rows = buildRemoteGitTreeRows(
      [status('README.md'), status('src/App.tsx'), status('src/components/Button.tsx'), status('assets/logo.svg')],
      new Set(),
    );

    expect(rows.map(row => [
      row.kind,
      row.name,
      row.depth,
      row.kind === 'directory' ? row.changeCount : row.status.path,
    ])).toEqual([
      ['directory', 'assets', 0, 1],
      ['file', 'logo.svg', 1, 'assets/logo.svg'],
      ['directory', 'src', 0, 2],
      ['directory', 'components', 1, 1],
      ['file', 'Button.tsx', 2, 'src/components/Button.tsx'],
      ['file', 'App.tsx', 1, 'src/App.tsx'],
      ['file', 'README.md', 0, 'README.md'],
    ]);
  });

  it('omits descendants of collapsed directories without losing root files', () => {
    const rows = buildRemoteGitTreeRows(
      [status('README.md'), status('src/App.tsx'), status('src/lib/api.ts')],
      new Set(['src']),
    );

    expect(rows.map(row => row.key)).toEqual(['directory:src', 'file: M:README.md']);
  });
});
