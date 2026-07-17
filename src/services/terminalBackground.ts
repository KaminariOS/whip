import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

const BACKGROUND_DIRECTORY_NAME = 'terminal-backgrounds';
const MANAGED_BACKGROUND_PREFIX = 'herdr-terminal-background-';

export async function selectTerminalBackgroundImage(
  currentUri: string | null,
): Promise<string | undefined> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.9,
  });
  if (result.canceled || !result.assets[0]) return undefined;

  const asset = result.assets[0];
  const source = new File(asset.uri);
  const directory = managedBackgroundDirectory();
  directory.create({ idempotent: true });
  const destination = new File(
    directory,
    `${MANAGED_BACKGROUND_PREFIX}${Date.now()}${imageExtension(asset.fileName, asset.mimeType)}`,
  );
  await source.copy(destination);
  await removeTerminalBackgroundImage(currentUri);
  return destination.uri;
}

export async function migrateTerminalBackgroundImage(uri: string | null): Promise<string | null> {
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
}

export async function removeTerminalBackgroundImage(uri: string | null): Promise<void> {
  if (!isBackedUpBackground(uri) && !isLegacyManagedBackground(uri)) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}

function managedBackgroundDirectory(): Directory {
  return new Directory(Paths.document, BACKGROUND_DIRECTORY_NAME);
}

function isBackedUpBackground(uri: string | null): uri is string {
  if (!uri) return false;
  const directoryPrefix = `${managedBackgroundDirectory().uri.replace(/\/$/, '')}/`;
  if (!uri.startsWith(directoryPrefix)) return false;
  const name = uri.slice(directoryPrefix.length);
  return name.startsWith(MANAGED_BACKGROUND_PREFIX) && !name.includes('/');
}

function backedUpBackgroundName(uri: string): string | null {
  const marker = `/${BACKGROUND_DIRECTORY_NAME}/`;
  const markerIndex = uri.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const name = uri.slice(markerIndex + marker.length);
  return name.startsWith(MANAGED_BACKGROUND_PREFIX) && !name.includes('/') ? name : null;
}

function isLegacyManagedBackground(uri: string | null): uri is string {
  if (!uri) return false;
  const documentPrefix = `${Paths.document.uri.replace(/\/$/, '')}/`;
  if (!uri.startsWith(documentPrefix)) return false;
  const relativePath = uri.slice(documentPrefix.length);
  return relativePath.startsWith(MANAGED_BACKGROUND_PREFIX) && !relativePath.includes('/');
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
