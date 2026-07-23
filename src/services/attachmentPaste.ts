import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { NativeModules, Platform } from 'react-native';

import { attachmentUploadName } from '../lib/attachmentPaste';

export type AttachmentSource = 'camera' | 'photo' | 'file' | 'clipboard';

export interface LocalAttachment {
  name: string;
  nativePath: string;
  previewUri: string | null;
  dispose: () => void;
}

interface ClipboardAttachmentResult {
  uri: string;
  name?: string;
  mimeType?: string;
}

interface ClipboardAttachmentNativeModule {
  hasAttachment(): Promise<boolean>;
  copyAttachment(): Promise<ClipboardAttachmentResult | null>;
}

const clipboardAttachment = Platform.OS === 'android'
  ? NativeModules.ClipboardAttachment as ClipboardAttachmentNativeModule | undefined
  : undefined;

let attachmentSequence = 0;

export async function hasClipboardAttachment(): Promise<boolean> {
  if (!clipboardAttachment) return false;
  try {
    return await clipboardAttachment.hasAttachment();
  } catch {
    return false;
  }
}

export async function pickLocalAttachment(source: AttachmentSource): Promise<LocalAttachment | null> {
  let picked: ClipboardAttachmentResult | null = null;
  let clipboardCopy: File | null = null;

  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Camera permission was not granted');
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      mediaTypes: ['images'],
      quality: 1,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (asset) picked = { uri: asset.uri, name: asset.fileName || undefined, mimeType: asset.mimeType };
  } else if (source === 'photo') {
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: false,
      mediaTypes: ['images'],
      quality: 1,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (asset) picked = { uri: asset.uri, name: asset.fileName || undefined, mimeType: asset.mimeType };
  } else if (source === 'file') {
    const result = await File.pickFileAsync({ multipleFiles: false });
    if (!result.canceled && result.result) {
      picked = { uri: result.result.uri, name: result.result.name };
    }
  } else {
    if (!clipboardAttachment) throw new Error('Clipboard attachments are unavailable in this build');
    picked = await clipboardAttachment.copyAttachment();
    if (picked) clipboardCopy = new File(picked.uri);
  }

  if (!picked) return null;
  const directory = new Directory(
    Paths.cache,
    `herdr-attachment-${Date.now()}-${++attachmentSequence}`,
  );
  directory.create({ idempotent: true });
  try {
    const name = attachmentUploadName(picked.name, picked.mimeType);
    const file = new File(directory, name);
    await new File(picked.uri).copy(file, { overwrite: true });
    return {
      name,
      nativePath: decodeURIComponent(file.uri.replace(/^file:\/\//, '')),
      previewUri: isImageAttachment(name, picked.mimeType) ? file.uri : null,
      dispose: () => {
        if (directory.exists) directory.delete();
      },
    };
  } catch (error) {
    if (directory.exists) directory.delete();
    throw error;
  } finally {
    if (clipboardCopy?.exists) clipboardCopy.delete();
  }
}

function isImageAttachment(name: string, mimeType?: string): boolean {
  return Boolean(
    mimeType?.startsWith('image/')
    || /\.(?:gif|heic|heif|jpe?g|png|webp)$/i.test(name),
  );
}
