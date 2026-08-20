import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { pickImageFromLibrary } from './imageLibraryPicker';

interface ManagedBackgroundImageStore {
  select: (currentUri: string | null) => Promise<string | undefined>;
  migrate: (uri: string | null) => Promise<string | null>;
  remove: (uri: string | null) => Promise<void>;
}

export function createManagedBackgroundImageStore(
  directoryName: string,
  filePrefix: string,
): ManagedBackgroundImageStore {
  const managedBackgroundDirectory = () => new Directory(Paths.document, directoryName);

  const isBackedUpBackground = (uri: string | null): uri is string => {
    if (!uri) return false;
    const directoryPrefix = `${managedBackgroundDirectory().uri.replace(/\/$/, '')}/`;
    if (!uri.startsWith(directoryPrefix)) return false;
    const name = uri.slice(directoryPrefix.length);
    return name.startsWith(filePrefix) && !name.includes('/');
  };

  const isLegacyManagedBackground = (uri: string | null): uri is string => {
    if (!uri) return false;
    const documentPrefix = `${Paths.document.uri.replace(/\/$/, '')}/`;
    if (!uri.startsWith(documentPrefix)) return false;
    const relativePath = uri.slice(documentPrefix.length);
    return relativePath.startsWith(filePrefix) && !relativePath.includes('/');
  };

  const backedUpBackgroundName = (uri: string): string | null => {
    const marker = `/${directoryName}/`;
    const markerIndex = uri.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    const name = uri.slice(markerIndex + marker.length);
    return name.startsWith(filePrefix) && !name.includes('/') ? name : null;
  };

  const remove = async (uri: string | null): Promise<void> => {
    if (!isBackedUpBackground(uri) && !isLegacyManagedBackground(uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  };

  return {
    select: async currentUri => {
      logBackgroundStage(directoryName, 'select:start');
      const picked = await pickImageFromLibrary();
      if (!picked) {
        logBackgroundStage(directoryName, 'picker:canceled');
        return undefined;
      }
      logBackgroundStage(directoryName, 'picker:confirmed', {
        mimeType: picked.mimeType || null,
        name: picked.name || null,
      });

      try {
        const source = new File(picked.uri);
        const directory = managedBackgroundDirectory();
        directory.create({ idempotent: true });
        const destination = new File(
          directory,
          `${filePrefix}${Date.now()}${imageExtension(picked.name, picked.mimeType)}`,
        );
        logBackgroundStage(directoryName, 'copy:start', { sourceExists: source.exists });
        if (Platform.OS === 'ios') source.copySync(destination);
        else await source.copy(destination);
        logBackgroundStage(directoryName, 'copy:complete', { destinationExists: destination.exists });
        logBackgroundStage(directoryName, 'remove-previous:start');
        await remove(currentUri);
        logBackgroundStage(directoryName, 'remove-previous:complete');
        return destination.uri;
      } finally {
        logBackgroundStage(directoryName, 'picker-dispose:start');
        picked.dispose();
        logBackgroundStage(directoryName, 'picker-dispose:complete');
      }
    },
    migrate: async uri => {
      if (!uri) return null;

      const directory = managedBackgroundDirectory();
      const restoredName = backedUpBackgroundName(uri);
      if (restoredName) {
        const restored = new File(directory, restoredName);
        if (restored.exists) return restored.uri;
      }

      if (!isLegacyManagedBackground(uri)) return uri;
      const source = new File(uri);
      if (!source.exists) return uri;

      directory.create({ idempotent: true });
      const destination = new File(directory, source.name);
      await source.copy(destination, { overwrite: true });
      return destination.uri;
    },
    remove,
  };
}

function logBackgroundStage(
  store: string,
  stage: string,
  details: Record<string, unknown> = {},
): void {
  const entry = `${JSON.stringify({ at: new Date().toISOString(), store, stage, ...details })}\n`;
  try {
    const log = new File(Paths.cache, 'herdr-background-debug.log');
    if (!log.exists) log.create({ intermediates: true });
    log.write(entry, { append: true });
  } catch {
    // Diagnostics must never block image replacement.
  }
  console.info('[BackgroundImage]', entry.trim());
}

function imageExtension(fileName?: string | null, mimeType?: string): string {
  const match = fileName?.match(/\.(jpe?g|png|webp|gif|heic|heif)$/i);
  if (match) return `.${match[1].toLowerCase().replace('jpeg', 'jpg')}`;
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return '.heic';
  return '.jpg';
}
