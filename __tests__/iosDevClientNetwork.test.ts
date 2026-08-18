import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('declares the Bonjour service required for iOS dev-client local network permission', () => {
  const appConfig = JSON.parse(readFileSync(resolve(__dirname, '../app.json'), 'utf8'));
  const infoPlist = readFileSync(resolve(__dirname, '../ios/HerdR/Info.plist'), 'utf8');

  expect(appConfig.expo.ios.infoPlist.NSBonjourServices).toContain('_expo._tcp');
  expect(infoPlist).toContain('<string>_expo._tcp</string>');
});
