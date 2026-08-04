import { File } from 'expo-file-system';
import { NativeModules } from 'react-native';

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

const imageLibraryPicker = NativeModules.ImageLibraryPicker as ImageLibraryPickerModule | undefined;

export async function pickImageFromLibrary(): Promise<PickedLibraryImage | null> {
  if (!imageLibraryPicker) throw new Error('The Android image picker is unavailable in this build');
  const result = await imageLibraryPicker.pickImage();
  if (!result) return null;

  return {
    ...result,
    dispose: () => {
      const file = new File(result.uri);
      if (file.exists) file.delete();
    },
  };
}
