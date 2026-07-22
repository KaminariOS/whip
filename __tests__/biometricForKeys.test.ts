import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { requiresBiometricForKeyUse, requiresBiometricForSavedKey } from '../src/lib/biometricSecurity';

test('protects only remembered private-key credentials when enabled', () => {
  expect(requiresBiometricForSavedKey({ authMode: 'key', rememberCredentials: true }, true)).toBe(true);
  expect(requiresBiometricForSavedKey({ authMode: 'password', rememberCredentials: true }, true)).toBe(false);
  expect(requiresBiometricForSavedKey({ authMode: 'key', rememberCredentials: false }, true)).toBe(false);
  expect(requiresBiometricForSavedKey({ authMode: 'key', rememberCredentials: true }, false)).toBe(false);
});

test('protects every private-key SSH connection while enabled', () => {
  expect(requiresBiometricForKeyUse({ authMode: 'key' }, true)).toBe(true);
  expect(requiresBiometricForKeyUse({ authMode: 'password' }, true)).toBe(false);
  expect(requiresBiometricForKeyUse({ authMode: 'key' }, false)).toBe(false);
});

test('requires biometric verification before copying a private key', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/ConnectionScreen.tsx'),
    'utf8',
  );
  expect(screen).toContain('if (onAuthenticatePrivateKey && !await onAuthenticatePrivateKey()) return;');
  expect(screen.indexOf('await onAuthenticatePrivateKey()')).toBeLessThan(
    screen.indexOf('Clipboard.setString(profile.secret)'),
  );
});

test('routes both security toggles through authenticated updates', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  expect(app).toContain('await updateSecuritySetting(() => {');
  expect(app).toContain('onBiometricForKeysChange={value => { updateBiometricForKeys(value)');
  expect(app).toContain('onBiometricOnResumeChange={value => { updateBiometricOnResume(value)');
});
