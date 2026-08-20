import {
  REMOTE_GIT_DIFF_MAX_BYTES,
  absoluteRemoteGitPath,
  buildRemoteGitTreeRows,
  parseRemoteGitDiff,
  parseRemoteGitRepository,
  parseRemoteGitStatus,
  remoteGitDiffCommand,
  remoteGitRepositoryCommand,
  remoteGitStatusCommand,
  remoteGitStatusLabel,
  type RemoteGitRepository,
  type RemoteGitStatusEntry,
} from '../src/lib/remoteGit';

const repository: RemoteGitRepository = {
  root: "/home/kosumi/it's-a-repo",
  hasHead: true,
};

const modified: RemoteGitStatusEntry = {
  indexStatus: ' ',
  worktreeStatus: 'M',
  path: 'src/App.tsx',
  originalPath: null,
};

describe('remote Git repository discovery', () => {
  it('quotes the inspected path and parses the tagged result', () => {
    const command = remoteGitRepositoryCommand("/tmp/it's-here");

    expect(command).toContain("git -C '\"'\"'");
    expect(command).toContain('rev-parse --show-toplevel');
    expect(
      parseRemoteGitRepository(
        [
          'ignored output',
          'WHIP_GIT_ROOT:/home/kosumi/repo',
          'WHIP_GIT_HEAD:1',
          '',
        ].join('\n'),
      ),
    ).toEqual({ root: '/home/kosumi/repo', hasHead: true });
    expect(parseRemoteGitRepository('not a repository')).toBeNull();
  });
});

describe('remote Git status', () => {
  it('requests an unquoted NUL-delimited porcelain status', () => {
    const command = remoteGitStatusCommand(repository.root);

    expect(command).toContain('core.quotepath=false');
    expect(command).toContain('status --porcelain=v1 -z --untracked-files=all');
    expect(command).toContain("'/home/kosumi/it'\"'\"'s-a-repo'");
  });

  it('parses modified, untracked, and renamed records', () => {
    const statuses = parseRemoteGitStatus(
      ' M src/App.tsx\0?? new file.txt\0R  new-name.ts\0old-name.ts\0',
    );

    expect(statuses).toEqual([
      {
        indexStatus: '?',
        worktreeStatus: '?',
        path: 'new file.txt',
        originalPath: null,
      },
      {
        indexStatus: 'R',
        worktreeStatus: ' ',
        path: 'new-name.ts',
        originalPath: 'old-name.ts',
      },
      modified,
    ]);
    expect(statuses.map(remoteGitStatusLabel)).toEqual(['??', 'R', 'M']);
  });
});

describe('remote Git status tree', () => {
  const status = (path: string): RemoteGitStatusEntry => ({
    ...modified,
    path,
  });

  it('groups directories before files and tracks nesting and change counts', () => {
    const rows = buildRemoteGitTreeRows(
      [
        status('README.md'),
        status('src/App.tsx'),
        status('src/components/Button.tsx'),
        status('assets/logo.svg'),
      ],
      new Set(),
    );

    expect(
      rows.map(row => [
        row.kind,
        row.name,
        row.depth,
        row.kind === 'directory' ? row.changeCount : row.status.path,
      ]),
    ).toEqual([
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

    expect(rows.map(row => row.key)).toEqual([
      'directory:src',
      'file: M:README.md',
    ]);
  });
});

describe('remote Git diffs', () => {
  it('builds bounded commands for tracked, untracked, and unborn files', () => {
    const tracked = remoteGitDiffCommand(repository, modified);
    const untracked = remoteGitDiffCommand(repository, {
      ...modified,
      indexStatus: '?',
      worktreeStatus: '?',
      path: 'new file.ts',
    });
    const unborn = remoteGitDiffCommand(
      { ...repository, hasHead: false },
      { ...modified, indexStatus: 'A', worktreeStatus: ' ' },
    );

    expect(tracked).toContain(
      '--no-ext-diff --no-textconv --no-color --unified=3',
    );
    expect(tracked).toContain("HEAD -- 'src/App.tsx'");
    expect(tracked).toContain(`head -c ${REMOTE_GIT_DIFF_MAX_BYTES + 1}`);
    expect(untracked).toContain('diff --no-index');
    expect(untracked).toContain("/dev/null 'new file.ts'");
    expect(unborn).toContain(
      'diff --no-ext-diff --no-textconv --no-color --unified=3 --cached',
    );
  });

  it('parses unified diff rows with both line-number columns', () => {
    const diff = parseRemoteGitDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -10,2 +10,2 @@',
        '-old',
        '+new',
        ' same',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );

    expect(diff.kind).toBe('text');
    expect(diff.truncated).toBe(false);
    expect(
      diff.rows.map(row => [row.kind, row.oldLine, row.newLine, row.content]),
    ).toEqual([
      ['header', null, null, 'diff --git a/a.ts b/a.ts'],
      ['header', null, null, '--- a/a.ts'],
      ['header', null, null, '+++ b/a.ts'],
      ['hunk', null, null, '@@ -10,2 +10,2 @@'],
      ['deletion', 10, null, 'old'],
      ['addition', null, 10, 'new'],
      ['context', 11, 11, 'same'],
      ['meta', null, null, '\\ No newline at end of file'],
    ]);
  });

  it('recognizes binary and empty output', () => {
    expect(
      parseRemoteGitDiff('Binary files a/image.png and b/image.png differ\n')
        .kind,
    ).toBe('binary');
    expect(parseRemoteGitDiff('').kind).toBe('empty');
    expect(absoluteRemoteGitPath('/repo/', '/src/App.tsx')).toBe(
      '/repo/src/App.tsx',
    );
  });
});
