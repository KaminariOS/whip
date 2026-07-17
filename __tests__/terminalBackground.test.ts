const mockExistingFiles = new Set<string>();
const mockCopies: Array<{ source: string; destination: string; overwrite?: boolean }> = [];
const mockDeletedFiles: string[] = [];
const mockCreatedDirectories: string[] = [];
const mockLaunchImageLibrary = jest.fn();

jest.mock('expo-file-system', () => {
  const join = (...parts: Array<string | { uri: string }>) => parts.reduce<string>((path, part) => {
    const value = typeof part === 'string' ? part : part.uri;
    return path ? `${path.replace(/\/$/, '')}/${value.replace(/^\//, '')}` : value;
  }, '');

  class Directory {
    uri: string;

    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = join(...parts);
    }

    create() {
      mockCreatedDirectories.push(this.uri);
    }
  }

  class File {
    uri: string;

    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = join(...parts);
    }

    get exists() {
      return mockExistingFiles.has(this.uri);
    }

    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }

    async copy(destination: File, options?: { overwrite?: boolean }) {
      mockCopies.push({ source: this.uri, destination: destination.uri, overwrite: options?.overwrite });
      mockExistingFiles.add(destination.uri);
    }

    delete() {
      mockDeletedFiles.push(this.uri);
      mockExistingFiles.delete(this.uri);
    }
  }

  return {
    Directory,
    File,
    Paths: { document: new Directory('file:///data/user/0/dev.herdr.remote/files/') },
  };
});

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibrary(...args),
}));

import {
  migrateTerminalBackgroundImage,
  removeTerminalBackgroundImage,
  selectTerminalBackgroundImage,
} from '../src/services/terminalBackground';

beforeEach(() => {
  mockExistingFiles.clear();
  mockCopies.length = 0;
  mockDeletedFiles.length = 0;
  mockCreatedDirectories.length = 0;
  mockLaunchImageLibrary.mockReset();
});

test('copies selected images into the backed-up terminal background directory', async () => {
  const previousUri = 'file:///data/user/0/dev.herdr.remote/files/herdr-terminal-background-old.webp';
  mockExistingFiles.add(previousUri);
  mockLaunchImageLibrary.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'content://picker/background', fileName: 'wallpaper.png', mimeType: 'image/png' }],
  });
  jest.spyOn(Date, 'now').mockReturnValueOnce(1234);

  await expect(selectTerminalBackgroundImage(previousUri)).resolves.toBe(
    'file:///data/user/0/dev.herdr.remote/files/terminal-backgrounds/herdr-terminal-background-1234.png',
  );
  expect(mockCreatedDirectories).toEqual([
    'file:///data/user/0/dev.herdr.remote/files/terminal-backgrounds',
  ]);
  expect(mockCopies).toEqual([{
    source: 'content://picker/background',
    destination: 'file:///data/user/0/dev.herdr.remote/files/terminal-backgrounds/herdr-terminal-background-1234.png',
    overwrite: undefined,
  }]);
  expect(mockDeletedFiles).toEqual([previousUri]);
});

test('moves a legacy app-private image into the backed-up directory', async () => {
  const legacyUri = 'file:///data/user/0/dev.herdr.remote/files/herdr-terminal-background-1.webp';
  mockExistingFiles.add(legacyUri);

  await expect(migrateTerminalBackgroundImage(legacyUri)).resolves.toBe(
    'file:///data/user/0/dev.herdr.remote/files/terminal-backgrounds/herdr-terminal-background-1.webp',
  );
  expect(mockCopies[0]).toEqual({
    source: legacyUri,
    destination: 'file:///data/user/0/dev.herdr.remote/files/terminal-backgrounds/herdr-terminal-background-1.webp',
    overwrite: true,
  });
});

test('rebases a restored image URI to the current Android app sandbox', async () => {
  const currentUri = 'file:///data/user/0/dev.herdr.remote/files/terminal-backgrounds/herdr-terminal-background-1.webp';
  mockExistingFiles.add(currentUri);

  await expect(migrateTerminalBackgroundImage(
    'file:///data/user/10/dev.herdr.remote/files/terminal-backgrounds/herdr-terminal-background-1.webp',
  )).resolves.toBe(currentUri);
  expect(mockCopies).toHaveLength(0);
});

test('does not delete similarly named files outside the managed app directory', async () => {
  const externalUri = 'file:///storage/emulated/0/terminal-backgrounds/herdr-terminal-background-1.webp';
  mockExistingFiles.add(externalUri);

  await removeTerminalBackgroundImage(externalUri);

  expect(mockDeletedFiles).toHaveLength(0);
});
