import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

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
  const destination = new File(
    Paths.document,
    `${MANAGED_BACKGROUND_PREFIX}${Date.now()}${imageExtension(asset.fileName, asset.mimeType)}`,
  );
  await source.copy(destination);
  await removeTerminalBackgroundImage(currentUri);
  return destination.uri;
}

export async function removeTerminalBackgroundImage(uri: string | null): Promise<void> {
  if (!isManagedBackground(uri)) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}

function isManagedBackground(uri: string | null): uri is string {
  return Boolean(
    uri
    && uri.startsWith(Paths.document.uri)
    && uri.slice(Paths.document.uri.length).startsWith(MANAGED_BACKGROUND_PREFIX),
  );
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
