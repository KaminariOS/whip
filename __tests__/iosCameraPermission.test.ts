import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

test('keeps the native iOS camera usage description in sync with Expo plugins', () => {
  const appConfig = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8'));
  const infoPlist = readFileSync(resolve(root, 'ios/HerdR/Info.plist'), 'utf8');
  const cameraPlugin = appConfig.expo.plugins.find(
    (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-camera',
  );
  const imagePickerPlugin = appConfig.expo.plugins.find(
    (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker',
  );
  const nativeDescription = infoPlist.match(
    /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];

  expect(nativeDescription).toBeTruthy();
  expect(cameraPlugin?.[1]?.cameraPermission).toBe(nativeDescription);
  expect(imagePickerPlugin?.[1]?.cameraPermission).toBe(nativeDescription);
});
