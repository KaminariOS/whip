import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { canPreviewRemoteTextFile, formatRemoteFileSize, isRemoteHiddenPath, joinRemotePath, nextRemoteFileSort, normalizeRemotePath, parentRemotePath, remoteCodeLanguage, remoteEntryName, remotePreviewKind, sortRemoteEntries } from '../src/lib/remoteFiles';

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
    expect(sortRemoteEntries([entry('file10.ts'), entry('z-dir/', true), entry('file2.ts'), entry('a-dir/', true)]).map(remoteEntryName)).toEqual(['a-dir', 'z-dir', 'file2.ts', 'file10.ts']);
  });

  it('sorts remote entries by size or modification date in either direction', () => {
    const oldSmall = {
      ...entry('old-small.txt'),
      fileSize: 10,
      modificationDate: '100',
    };
    const newLarge = {
      ...entry('new-large.txt'),
      fileSize: 200,
      modificationDate: '300',
    };
    const middle = {
      ...entry('middle.txt'),
      fileSize: 50,
      modificationDate: '200',
    };
    const directory = {
      ...entry('folder/', true),
      fileSize: 999,
      modificationDate: '50',
    };

    expect(sortRemoteEntries([oldSmall, directory, newLarge, middle], 'size', 'descending').map(remoteEntryName)).toEqual(['folder', 'new-large.txt', 'middle.txt', 'old-small.txt']);
    expect(sortRemoteEntries([oldSmall, directory, newLarge, middle], 'modified', 'ascending').map(remoteEntryName)).toEqual(['folder', 'old-small.txt', 'middle.txt', 'new-large.txt']);
  });

  it('identifies hidden files and hidden path segments', () => {
    expect(isRemoteHiddenPath('.env')).toBe(true);
    expect(isRemoteHiddenPath('src/.generated/schema.ts')).toBe(true);
    expect(isRemoteHiddenPath('src/App.tsx')).toBe(false);
  });

  it('uses natural defaults and reverses a selected sort field', () => {
    expect(nextRemoteFileSort('name', 'ascending', 'modified')).toEqual({
      field: 'modified',
      direction: 'descending',
    });
    expect(nextRemoteFileSort('modified', 'descending', 'modified')).toEqual({
      field: 'modified',
      direction: 'ascending',
    });
    expect(nextRemoteFileSort('size', 'descending', 'name')).toEqual({
      field: 'name',
      direction: 'ascending',
    });
  });
});

describe('remote file previews', () => {
  it('allows bounded text and code files', () => {
    expect(canPreviewRemoteTextFile('App.tsx', 1000)).toBe(true);
    expect(canPreviewRemoteTextFile('.env.local', 1000)).toBe(true);
    expect(canPreviewRemoteTextFile('architecture.svg', 1000)).toBe(true);
    expect(canPreviewRemoteTextFile('architecture.mmd', 1000)).toBe(true);
    expect(canPreviewRemoteTextFile('photo.png', 1000)).toBe(false);
    expect(canPreviewRemoteTextFile('large.md', 600 * 1024)).toBe(false);
    expect(remotePreviewKind('README.md', 1000)).toBe('markdown');
    expect(remotePreviewKind('index.html', 1000)).toBe('html');
    expect(remotePreviewKind('legacy.htm', 1000)).toBe('html');
    expect(remotePreviewKind('App.tsx', 1000)).toBe('code');
    expect(remotePreviewKind('config.json', 1000)).toBe('code');
    expect(remotePreviewKind('config.toml', 1000)).toBe('code');
    expect(remotePreviewKind('config.yaml', 1000)).toBe('code');
    expect(remotePreviewKind('notes.txt', 1000)).toBe('text');
    expect(remotePreviewKind('photo.png', 1000)).toBe('image');
    expect(remotePreviewKind('architecture.svg', 1000)).toBe('svg');
    expect(remotePreviewKind('architecture.mmd', 1000)).toBe('mermaid');
    expect(remotePreviewKind('sequence.mermaid', 1000)).toBe('mermaid');
    expect(remotePreviewKind('large.mmd', 100_001)).toBe('unsupported');
    expect(remotePreviewKind('large.svg', 600 * 1024)).toBe('unsupported');
    expect(remotePreviewKind('recording.mp4', 1000)).toBe('video');
    expect(remotePreviewKind('screen.webm', 1000)).toBe('video');
    expect(remotePreviewKind('large.mov', 20 * 1024 * 1024 * 1024)).toBe('video');
    expect(remotePreviewKind('podcast.mp3', 1000)).toBe('audio');
    expect(remotePreviewKind('voice.opus', 1000)).toBe('audio');
    expect(remotePreviewKind('report.pdf', 1000)).toBe('pdf');
    expect(remotePreviewKind('archive.zip', 1000)).toBe('unsupported');
  });

  it('maps remote filenames to syntax highlighter languages', () => {
    expect(remoteCodeLanguage('Component.tsx')).toBe('typescript');
    expect(remoteCodeLanguage('Dockerfile')).toBe('dockerfile');
    expect(remoteCodeLanguage('script.sh')).toBe('bash');
    expect(remoteCodeLanguage('settings.json')).toBe('json');
    expect(remoteCodeLanguage('settings.toml')).toBe('toml');
    expect(remoteCodeLanguage('settings.yml')).toBe('yaml');
    expect(remoteCodeLanguage('README.md')).toBe('markdown');
    expect(remoteCodeLanguage('architecture.svg')).toBe('xml');
    expect(remoteCodeLanguage('unknown.source')).toBe('plaintext');
  });

  it('formats file sizes compactly', () => {
    expect(formatRemoteFileSize(0)).toBe('0 B');
    expect(formatRemoteFileSize(1536)).toBe('1.5 KB');
    expect(formatRemoteFileSize(12 * 1024 * 1024)).toBe('12 MB');
  });
});

test('connects the adaptive terminal file control to the remote file manager', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const session = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');
  const terminal = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');
  expect(terminal).toContain("accessibilityLabel={t('terminal.openFiles')}");
  expect(terminal).toContain('<FolderOpen');
  expect(terminal).toContain('onRequestFiles?.()');
  expect(session).toContain('onOpenFiles(activeTerminalSession.terminalId)');
  expect(app).toContain('pane.foreground_cwd');
  expect(app).toContain('<RemoteFileManager');
});

test('offers persistent hidden-file visibility and compact reversible sorting', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const preferences = readFileSync(resolve(__dirname, '../src/services/remoteFilePreferences.ts'), 'utf8');
  expect(manager).toContain("accessibilityLabel={t('files.options')}");
  expect(manager).toContain('sortRemoteEntries(visibleEntries, sortField, sortDirection)');
  expect(manager).toContain('isRemoteHiddenPath(status.path)');
  expect(manager).toContain('checked={showHiddenFiles}');
  expect(manager).toContain('nextRemoteFileSort(sortField, sortDirection, field)');
  expect(manager).toMatch(/const remoteFileSortFields: RemoteFileSortField\[\] =\s*\[\s*'name',\s*'modified',\s*'size',?\s*\];/);
  expect(preferences).toContain('whip.remote-files.preferences.v1');
});

test('remembers the last remote directory independently for each terminal', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const session = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');

  expect(app).toContain('const remoteFilePathsRef = useRef(new Map<string, string>());');
  expect(app).toContain('const pathKey = `${sessionId}:${terminalId}`;');
  expect(app).toContain('remoteFilePathsRef.current.get(pathKey)');
  expect(app).toContain('remoteFilePathsRef.current.set(remoteFilesRequest.pathKey, path)');
  expect(session).toContain('onRequestFiles={openFileManager}');
  expect(session).toContain('onOpenFiles(activeTerminalSession.terminalId)');
  expect(manager).toContain('onPathChangeRef.current(listing.path);');
});

test('opens an agent tab remote directory on long press', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const herd = readFileSync(resolve(__dirname, '../src/components/HerdScreen.tsx'), 'utf8');
  const openAgentFiles = app.slice(
    app.indexOf('const openAgentFiles ='),
    app.indexOf('const selectHerdHost ='),
  );

  expect(herd).toContain('onLongPress={hapticPress(() => onOpenFiles(item.hostId, agent))}');
  expect(herd).toContain("name: 'open-files'");
  expect(app).toContain('onOpenFiles={openAgentFiles}');
  expect(openAgentFiles).toContain('openRemoteFiles(sessionId, pane.terminal_id);');
  expect(openAgentFiles).not.toContain('openPaneTerminal(');
  expect(app).toContain('<RemoteFileManager');
  expect(app).toContain('client={remoteFilesRuntime.client}');
  expect(app).toContain('initialPath={remoteFilesRequest.initialPath}');
});

test('uses the authenticated SSH client for SFTP listing, transfers, and deletion', () => {
  const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');
  expect(client).toContain('async listRemoteDirectory(');
  expect(client).toContain('.sftpLs(resolvedPath)');
  expect(client).toContain('downloadRemoteFile(');
  expect(client).toContain('.sftpDownload(path, localDirectoryPath)');
  expect(client).toContain('uploadRemoteFile(');
  expect(client).toContain('.sftpUpload(localFilePath, remoteDirectoryPath)');
  expect(client).toContain('deleteRemoteEntry(');
  expect(client).toContain('isDirectory ? client.sftpRmdir(path) : client.sftpRm(path)');
});

test('supports native Markdown previews and file transfer actions', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const markdown = readFileSync(resolve(__dirname, '../src/components/MarkdownPreview.tsx'), 'utf8');
  const transfer = readFileSync(resolve(__dirname, '../src/services/remoteFileTransfer.ts'), 'utf8');
  expect(manager).toContain('<MarkdownPreview');
  expect(manager).toContain('onOpenRemotePath={openRemotePath}');
  expect(manager).toContain('saveCachedRemoteText(');
  expect(manager).toContain('pickLocalFileForUpload(');
  expect(manager).toContain('copyCachedRemoteFileToPickedDirectory(');
  expect(markdown).toContain('EnrichedMarkdownText');
  expect(markdown).toContain('flavor="github"');
  expect(markdown).toContain('rewriteMarkdownImages');
  expect(markdown).toContain('cacheRemoteFile(client, path)');
  expect(transfer).toContain('File.pickFileAsync(');
});

test('streams remote videos from the token-protected SFTP file server', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const preview = readFileSync(resolve(__dirname, '../src/components/RemoteVideoPreview.tsx'), 'utf8');
  const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');
  expect(manager).toContain("preview.kind === 'video' && preview.sftpFileServer");
  expect(manager).toContain('<RemoteVideoPreview');
  expect(manager).toContain("kind === 'video'");
  expect(manager).toContain('client.openRemoteSftpFileServer(entryPath)');
  expect(manager).toContain('.closeRemoteSftpFileServer(');
  expect(client).toContain('client.startSftpFileServer(remotePath)');
  expect(preview).toContain('useVideoPlayer(uri,');
  expect(preview).toContain('nativeControls');
  expect(preview).toContain('contentFit="contain"');
  expect(preview).toContain('fullscreenOptions={{ enable: true }}');
});

test('streams remote audio with resumable native controls', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const preview = readFileSync(resolve(__dirname, '../src/components/RemoteAudioPreview.tsx'), 'utf8');
  expect(manager).toContain("preview.kind === 'audio' && preview.sftpFileServer");
  expect(manager).toContain('<RemoteAudioPreview');
  expect(preview).toContain('useAudioPlayer(');
  expect(preview).toContain('loadRemoteContentProgress(');
  expect(preview).toContain('saveRemoteContentProgress(');
});

test('restores progress for remote text and Markdown previews', () => {
  const code = readFileSync(resolve(__dirname, '../src/components/CodePreview.tsx'), 'utf8');
  const markdown = readFileSync(resolve(__dirname, '../src/components/MarkdownPreview.tsx'), 'utf8');
  const text = readFileSync(resolve(__dirname, '../src/components/RemoteTextPreview.tsx'), 'utf8');
  expect(code).toContain('useRemoteScrollProgress(progressIdentity)');
  expect(markdown).toContain('useRemoteScrollProgress(progressIdentity)');
  expect(text).toContain('useRemoteScrollProgress(progressIdentity)');
});

test('opens streamed remote PDFs in an Android Custom Tab and returns to the directory', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const packageJson = readFileSync(resolve(__dirname, '../package.json'), 'utf8');
  const appJson = readFileSync(resolve(__dirname, '../app.json'), 'utf8');
  expect(manager).toContain("kind === 'pdf'");
  expect(manager).toContain("preview.kind === 'pdf' && preview.sftpFileServer");
  expect(manager).toContain("import * as WebBrowser from 'expo-web-browser'");
  expect(manager).toContain('WebBrowser.openBrowserAsync(url)');
  expect(manager).toContain("AppState.addEventListener('change'");
  expect(manager).toContain('finishPdfBrowser(request)');
  expect(manager).toContain("t('files.openPdf')");
  expect(packageJson).toContain('"expo-web-browser": "~57.0.2"');
  expect(appJson).toContain('"expo-web-browser"');
});

test('renders standalone Mermaid files with the bundled isolated WebView runtime', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const preview = readFileSync(resolve(__dirname, '../src/components/MermaidPreview.tsx'), 'utf8');
  const runtime = readFileSync(resolve(__dirname, '../scripts/mermaid-preview-runtime.js'), 'utf8');
  const markdown = readFileSync(resolve(__dirname, '../src/components/MarkdownPreview.tsx'), 'utf8');

  expect(manager).toContain("preview.kind === 'mermaid'");
  expect(manager).toContain('<MermaidPreview');
  expect(preview).toContain("file:///android_asset/mermaid-preview.html");
  expect(preview).toContain('window.herdrRenderMermaid(');
  expect(preview).toContain('allowUniversalAccessFromFileURLs={false}');
  expect(runtime).toContain("securityLevel: 'strict'");
  expect(runtime).toContain('maxEdges: MAX_EDGES');
  expect(runtime).toContain('htmlLabels: true');
  expect(runtime).toContain("flowchart: { htmlLabels: true }");
  expect(runtime).toContain('const result = await mermaid.render(id, source)');
  expect(markdown).not.toContain('MermaidPreview');
});

test('opens cached images in the zoomable image preview', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const preview = readFileSync(resolve(__dirname, '../src/components/ZoomableImagePreview.tsx'), 'utf8');

  expect(manager).toContain('<ZoomableImagePreview');
  expect(manager).toContain('uri={preview.cached.uri}');
  expect(preview).toContain('touchDistance(touches)');
  expect(preview).toContain('touchCentroid(touches)');
  expect(preview).toContain('DOUBLE_TAP_IMAGE_ZOOM');
  expect(preview).toContain("gestureModeRef.current = 'pan'");
});

test('renders bounded SVG files natively while retaining source editing', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const preview = readFileSync(resolve(__dirname, '../src/components/SvgPreview.tsx'), 'utf8');

  expect(manager).toContain("preview.kind === 'svg'");
  expect(manager).toContain('<SvgPreview');
  expect(manager).toContain("kind === 'svg'");
  expect(preview).toContain('parse(content, sanitizeRemoteSvgAst)');
  expect(preview).toContain('<SvgAst');
  expect(preview).toContain("preserveAspectRatio: 'xMidYMid meet'");
});

test('tunnels a remote Python HTML server into the in-app WebView while retaining source editing', () => {
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const preview = readFileSync(resolve(__dirname, '../src/components/HtmlPreview.tsx'), 'utf8');
  expect(manager).toContain('<HtmlPreview');
  expect(manager).toContain("kind === 'html'");
  expect(manager).toContain('client.openRemoteHtmlPreview(entryPath)');
  expect(manager).toContain('client.closeRemoteHtmlPreview');
  expect(preview).toContain('javaScriptEnabled');
  expect(preview).toContain('allowFileAccess={false}');
  expect(preview).toContain("originWhitelist={['http://*', 'https://*']}");
  expect(preview).toContain('source={{ uri: previewUrl }}');
});

test('uses the requested syntax highlighter and terminal font in previews and editors', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const preview = readFileSync(resolve(__dirname, '../src/components/CodePreview.tsx'), 'utf8');
  expect(preview).toContain("from 'react-native-code-highlighter'");
  expect(preview).toContain('remoteCodeLanguage(filename)');
  expect(preview).toContain('atomOneDarkReasonable');
  expect(preview).toContain('export function CodeEditor');
  expect(preview).toContain('lineNumbers:');
  expect(preview).toContain('fontFamily: terminalFontFamily');
  expect(manager).toContain('<CodeEditor');
  expect(app).toContain("require('./assets/terminal-fonts/JetBrainsMono-Regular.ttf')");
});

test('uses proportional UI typography for remote file context and metadata', () => {
  const manager = readFileSync(
    resolve(__dirname, '../src/components/RemoteFileManager.tsx'),
    'utf8',
  );
  const terminal = readFileSync(
    resolve(__dirname, '../src/components/TerminalScreen.tsx'),
    'utf8',
  );

  expect(manager).toContain(
    'className="text-[8px] uppercase tracking-[1px] text-muted-foreground"',
  );
  expect(manager).toContain(
    'className="min-w-0 flex-1 text-[10px] text-foreground"',
  );
  expect(manager).toContain(
    'className="mt-0.5 text-[8px] text-muted-foreground"',
  );
  expect(terminal).toContain(
    'className="bg-terminal-error/15 px-2 py-1 text-[8px] text-terminal-error"',
  );
  expect(terminal).toContain(
    'className="flex-1 text-[9px] tracking-[1px] text-terminal-muted"',
  );
  expect(terminal).toContain(
    'className="text-[8px] text-terminal-error"',
  );
});

test('uses proportional typography for empty states and preview errors', () => {
  const session = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');
  const mermaid = readFileSync(resolve(__dirname, '../src/components/MermaidPreview.tsx'), 'utf8');
  const svg = readFileSync(resolve(__dirname, '../src/components/SvgPreview.tsx'), 'utf8');

  expect(session).toContain('className="font-black text-terminal-text"');
  expect(session).toContain('className="text-[8px] uppercase tracking-[1px] text-muted-foreground"');
  expect(session).toContain('className="mt-2 text-center text-[9px] text-muted-foreground"');
  expect(mermaid).toContain('className="mt-2 text-center text-[9px] leading-[14px] text-muted-foreground"');
  expect(svg).toContain('className="mt-2 text-center text-[9px] leading-[14px] text-muted-foreground"');
});

test('offers a persistent collapsible Git status tree and native virtualized diffs', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const manager = readFileSync(resolve(__dirname, '../src/components/RemoteFileManager.tsx'), 'utf8');
  const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');
  const diff = readFileSync(resolve(__dirname, '../src/components/RemoteGitDiffPreview.tsx'), 'utf8');
  const preferences = readFileSync(resolve(__dirname, '../src/services/remoteGitPreferences.ts'), 'utf8');

  expect(app).toContain('hostId={remoteFilesRequest.hostSessionId}');
  expect(manager).toContain('accessibilityRole="switch"');
  expect(manager).toContain('loadRemoteGitMode(hostId, repository.root)');
  expect(manager).toContain('buildRemoteGitTreeRows(visibleGitStatus, gitCollapsedPaths)');
  expect(manager).toContain('accessibilityState={{ expanded }}');
  expect(manager).toContain('saveRemoteGitCollapsedPaths(hostId, repository.root');
  expect(manager).toContain('<RemoteGitDiffPreview');
  expect(client).toContain('async discoverRemoteGitRepository(');
  expect(client).toContain('async listRemoteGitChanges(');
  expect(client).toContain('async loadRemoteGitDiff(');
  expect(diff).toContain('<FlatList');
  expect(diff).toContain("removeClippedSubviews={Platform.OS === 'android'}");
  expect(preferences).toContain('whip.remote-git-mode.v1');
});
