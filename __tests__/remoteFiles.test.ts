import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canPreviewRemoteTextFile,
  formatRemoteFileSize,
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
  remoteEntryName,
  remotePreviewKind,
  sortRemoteEntries,
} from '../src/lib/remoteFiles';

const entry = (filename: string, isDirectory = false) => ({
  filename,
  isDirectory,
  modificationDate: '',
  lastAccess: '',
  fileSize: 0,
  ownerUserID: 0,
  ownerGroupID: 0,
  flags: 0,
});

describe('remote file paths', () => {
  it('starts relative and tilde paths from the remote home', () => {
    expect(normalizeRemotePath(undefined, '/home/kosumi')).toBe('/home/kosumi');
    expect(normalizeRemotePath('~/repos/herdr', '/home/kosumi')).toBe('/home/kosumi/repos/herdr');
    expect(normalizeRemotePath('../shared', '/home/kosumi')).toBe('/home/shared');
  });

  it('joins entries and navigates to parents without escaping root', () => {
    expect(remoteEntryName(entry('src/'))).toBe('src');
    expect(joinRemotePath('/home/kosumi', 'src/')).toBe('/home/kosumi/src');
    expect(joinRemotePath('/', 'etc')).toBe('/etc');
    expect(parentRemotePath('/home/kosumi/src')).toBe('/home/kosumi');
    expect(parentRemotePath('/')).toBe('/');
  });

  it('sorts directories first and filenames naturally', () => {
    expect(sortRemoteEntries([
      entry('file10.ts'),
      entry('z-dir/', true),
      entry('file2.ts'),
      entry('a-dir/', true),
    ]).map(remoteEntryName)).toEqual(['a-dir', 'z-dir', 'file2.ts', 'file10.ts']);
  });
});

describe('remote file previews', () => {
  it('allows bounded text and code files', () => {
    expect(canPreviewRemoteTextFile('App.tsx', 1000)).toBe(true);
    expect(canPreviewRemoteTextFile('.env.local', 1000)).toBe(true);
    expect(canPreviewRemoteTextFile('photo.png', 1000)).toBe(false);
    expect(canPreviewRemoteTextFile('large.md', 600 * 1024)).toBe(false);
    expect(remotePreviewKind('README.md', 1000)).toBe('markdown');
    expect(remotePreviewKind('App.tsx', 1000)).toBe('code');
    expect(remotePreviewKind('notes.txt', 1000)).toBe('text');
    expect(remotePreviewKind('photo.png', 1000)).toBe('image');
    expect(remotePreviewKind('archive.zip', 1000)).toBe('unsupported');
  });

  it('formats file sizes compactly', () => {
    expect(formatRemoteFileSize(0)).toBe('0 B');
    expect(formatRemoteFileSize(1536)).toBe('1.5 KB');
    expect(formatRemoteFileSize(12 * 1024 * 1024)).toBe('12 MB');
  });
});

test('places the remote file manager immediately before the terminal web button', () => {
  const screen = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');
  const files = screen.indexOf("accessibilityLabel={t('terminal.openFiles')}");
  const web = screen.indexOf("accessibilityLabel={t('terminal.scanLinks')}");
  expect(files).toBeGreaterThan(0);
  expect(web).toBeGreaterThan(files);
  expect(screen.slice(files, web)).toContain('<FolderOpen');
  expect(screen).toContain('selectedPane?.foreground_cwd');
  expect(screen).toContain('<RemoteFileManager');
});

test('uses the authenticated SSH client for SFTP listing, downloads, and uploads', () => {
  const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');
  expect(client).toContain('async listRemoteDirectory(');
  expect(client).toContain('.sftpLs(resolvedPath)');
  expect(client).toContain('downloadRemoteFile(');
  expect(client).toContain('.sftpDownload(path, localDirectoryPath)');
  expect(client).toContain('uploadRemoteFile(');
  expect(client).toContain('.sftpUpload(localFilePath, remoteDirectoryPath)');
});

test('supports native Markdown previews and file transfer actions', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const markdown = readFileSync(resolve(__dirname, '../src/components/MarkdownPreview.tsx'), 'utf8');
  const transfer = readFileSync(resolve(__dirname, '../src/services/remoteFileTransfer.ts'), 'utf8');
  expect(manager).toContain('<MarkdownPreview');
  expect(manager).toContain('saveCachedRemoteText(');
  expect(manager).toContain('pickLocalFileForUpload(');
  expect(manager).toContain('copyCachedRemoteFileToPickedDirectory(');
  expect(markdown).toContain('EnrichedMarkdownText');
  expect(markdown).toContain('flavor="github"');
  expect(transfer).toContain('File.pickFileAsync(');
});
