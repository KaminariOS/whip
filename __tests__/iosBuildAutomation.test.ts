import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const readSource = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('uses one validated unsigned iOS build path in CI and releases', () => {
  const ci = readSource('.github/workflows/ci.yml');
  const release = readSource('.github/workflows/build-apk.yml');

  for (const workflow of [ci, release]) {
    expect(workflow).toContain('scripts/build-ios-app.sh');
    expect(workflow).toContain('--unsigned');
    expect(workflow).toContain('whip-ios-unsigned-compile-only');
  }

  expect(release).not.toContain('Upload iOS app to GitHub Release');
  expect(release).not.toContain('Whip unsigned iOS app');
});

test('the shared builder validates architecture, permissions, and signatures', () => {
  const builder = readSource('scripts/build-ios-app.sh');

  expect(builder).toContain('architectures" != "arm64"');
  expect(builder).toContain('NSCameraUsageDescription');
  expect(builder).toContain('NSFaceIDUsageDescription');
  expect(builder).toContain('NSLocalNetworkUsageDescription');
  expect(builder).toContain('NSPhotoLibraryUsageDescription');
  expect(builder).toContain('codesign --verify --deep --strict');
});

test('the device installer performs an in-place install and launch', () => {
  const installer = readSource('scripts/install-ios-device.sh');

  expect(installer).toContain('-c pod install');
  expect(installer).not.toContain('bundle exec pod install');
  expect(installer).toContain('device install app');
  expect(installer).toContain('device process launch');
  expect(installer).toContain('app installed, but launch was unavailable');
  expect(installer).not.toMatch(/device uninstall|simctl uninstall/);
});
