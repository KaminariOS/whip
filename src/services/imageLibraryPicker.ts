import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { NativeModules, Platform } from 'react-native';

interface NativePickedImage {
  uri: string;
  name?: string;
  mimeType?: string;
}

interface ImageLibraryPickerModule {
  pickImage(): Promise<NativePickedImage | null>;
}

export interface PickedLibraryImage extends NativePickedImage {
  dispose: () => void;
}

const imageLibraryPicker = Platform.OS === 'android'
  ? NativeModules.ImageLibraryPicker as ImageLibraryPickerModule | undefined
  : undefined;

export async function pickImageFromLibrary(): Promise<PickedLibraryImage | null> {
  const result = Platform.OS === 'android'
    ? await pickImageWithAndroidModule()
    : await pickImageWithExpo();
  if (!result) return null;

  return {
    ...result,
    dispose: () => {
      const file = new File(result.uri);
      if (file.exists) file.delete();
    },
  };
}

async function pickImageWithAndroidModule(): Promise<NativePickedImage | null> {
  if (!imageLibraryPicker) {
    throw new Error('The Android image picker is unavailable in this build');
  }
  return imageLibraryPicker.pickImage();
}

async function pickImageWithExpo(): Promise<NativePickedImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    allowsEditing: false,
    mediaTypes: ['images'],
    // Expo's `.current` fast path waits on NSItemProvider.loadFileRepresentation.
    // On physical iOS 26 devices that callback can fail to arrive after the user
    // confirms a selection, leaving the JS promise pending forever. Requesting a
    // compatible representation uses the data-loading path instead.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    quality: 1,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.fileName || undefined,
    mimeType: asset.mimeType,
  };
}
