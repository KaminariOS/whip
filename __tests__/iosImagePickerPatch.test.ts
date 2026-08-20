import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const readSource = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('uses the reusable legacy iOS picker for single image selection', () => {
  const patch = readSource('patches/expo-image-picker+57.0.12.patch');
  const infoPlist = readSource('ios/HerdR/Info.plist');

  expect(patch).toContain('if options.allowsMultipleSelection && sourceType != .camera');
  expect(infoPlist).toContain('<key>NSPhotoLibraryUsageDescription</key>');
});
