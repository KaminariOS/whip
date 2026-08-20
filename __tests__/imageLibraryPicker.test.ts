const mockLaunchImageLibraryAsync = jest.fn();
const mockDelete = jest.fn();

jest.mock('expo-image-picker', () => ({
  UIImagePickerPreferredAssetRepresentationMode: {
    Compatible: 'compatible',
  },
  launchImageLibraryAsync: (...args: unknown[]) =>
    mockLaunchImageLibraryAsync(...args),
}));

jest.mock('expo-file-system', () => ({
  File: class {
    exists = true;

    delete = mockDelete;
  },
}));

jest.mock('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'ios' },
}));

import { pickImageFromLibrary } from '../src/services/imageLibraryPicker';

beforeEach(() => {
  mockLaunchImageLibraryAsync.mockReset();
  mockDelete.mockReset();
});

test('uses the Expo image library picker on iOS', async () => {
  mockLaunchImageLibraryAsync.mockResolvedValue({
    canceled: false,
    assets: [{
      uri: 'file:///ios-picker/background.jpg',
      fileName: 'background.jpg',
      mimeType: 'image/jpeg',
    }],
  });

  const picked = await pickImageFromLibrary();

  expect(mockLaunchImageLibraryAsync).toHaveBeenCalledWith({
    allowsEditing: false,
    mediaTypes: ['images'],
    preferredAssetRepresentationMode: 'compatible',
    quality: 1,
  });
  expect(picked).toMatchObject({
    uri: 'file:///ios-picker/background.jpg',
    name: 'background.jpg',
    mimeType: 'image/jpeg',
  });

  picked?.dispose();
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

test('returns null when the iOS image picker is canceled', async () => {
  mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: [] });

  await expect(pickImageFromLibrary()).resolves.toBeNull();
  expect(mockDelete).not.toHaveBeenCalled();
});
