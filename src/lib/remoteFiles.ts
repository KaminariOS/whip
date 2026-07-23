import type { LsResult } from '@dylankenneally/react-native-ssh-sftp';

export const MAX_REMOTE_TEXT_PREVIEW_BYTES = 512 * 1024;
export const MAX_REMOTE_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;

export type RemotePreviewKind = 'code' | 'image' | 'markdown' | 'text' | 'unsupported';

const CODE_EXTENSIONS = new Set([
  'bash', 'c', 'cc', 'cjs', 'cpp', 'css', 'fish', 'go', 'gradle', 'graphql', 'h',
  'hpp', 'html', 'java', 'js', 'json', 'jsx', 'kt', 'kts', 'lua', 'mjs', 'nix',
  'proto', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx',
  'xml', 'yaml', 'yml', 'zsh',
]);

const TEXT_EXTENSIONS = new Set([
  'cfg', 'conf', 'csv', 'env', 'ini', 'lock', 'log', 'properties', 'txt',
]);

const CODE_FILENAMES = new Set(['containerfile', 'dockerfile', 'gemfile', 'justfile', 'makefile']);
const TEXT_FILENAMES = new Set(['license', 'readme']);
const MARKDOWN_EXTENSIONS = new Set(['markdown', 'md', 'mdx']);
const IMAGE_EXTENSIONS = new Set(['bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'webp']);

const CODE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  css: 'css',
  fish: 'shell',
  go: 'go',
  gradle: 'groovy',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  html: 'xml',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  mjs: 'javascript',
  nix: 'nix',
  proto: 'protobuf',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

const CODE_LANGUAGE_BY_FILENAME: Record<string, string> = {
  containerfile: 'dockerfile',
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  justfile: 'makefile',
  makefile: 'makefile',
};

export function remoteEntryName(entry: Pick<LsResult, 'filename'>): string {
  return entry.filename.replace(/\/+$/, '');
}

export function normalizeRemotePath(path: string | undefined, home: string): string {
  const trimmed = path?.trim() || home;
  const expanded = trimmed === '~'
    ? home
    : trimmed.startsWith('~/')
      ? `${home}/${trimmed.slice(2)}`
      : trimmed.startsWith('/')
        ? trimmed
        : `${home}/${trimmed}`;
  const segments: string[] = [];
  for (const segment of expanded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function joinRemotePath(directory: string, name: string): string {
  const cleanDirectory = directory === '/' ? '' : directory.replace(/\/+$/, '');
  return `${cleanDirectory}/${name.replace(/^\/+|\/+$/g, '')}` || '/';
}

export function parentRemotePath(path: string): string {
  const normalized = path.replace(/\/+$/, '') || '/';
  const separator = normalized.lastIndexOf('/');
  return separator <= 0 ? '/' : normalized.slice(0, separator);
}

export function sortRemoteEntries(entries: LsResult[]): LsResult[] {
  return [...entries].sort((left, right) => {
    const directoryOrder = Number(Boolean(right.isDirectory)) - Number(Boolean(left.isDirectory));
    return directoryOrder || remoteEntryName(left).localeCompare(remoteEntryName(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

export function canPreviewRemoteTextFile(filename: string, fileSize: number): boolean {
  return ['code', 'markdown', 'text'].includes(remotePreviewKind(filename, fileSize));
}

export function remotePreviewKind(filename: string, fileSize: number): RemotePreviewKind {
  if (!Number.isFinite(fileSize) || fileSize < 0) return 'unsupported';
  const lower = filename.toLowerCase();
  const base = lower.split('/').pop() || lower;
  const extension = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (IMAGE_EXTENSIONS.has(extension)) {
    return fileSize <= MAX_REMOTE_IMAGE_PREVIEW_BYTES ? 'image' : 'unsupported';
  }
  if (fileSize > MAX_REMOTE_TEXT_PREVIEW_BYTES) return 'unsupported';
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (CODE_FILENAMES.has(base) || CODE_EXTENSIONS.has(extension)) return 'code';
  if (TEXT_FILENAMES.has(base) || base.startsWith('.env') || TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'unsupported';
}

export function remoteCodeLanguage(filename: string): string {
  const base = filename.toLowerCase().split('/').pop() || filename.toLowerCase();
  if (CODE_LANGUAGE_BY_FILENAME[base]) return CODE_LANGUAGE_BY_FILENAME[base];
  const extension = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  return CODE_LANGUAGE_BY_EXTENSION[extension] || 'plaintext';
}

export function formatRemoteFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
