import {
  requiresBiometricForKeyUse,
  requiresBiometricForSavedKey,
} from '../src/lib/biometricSecurity';

test('protects saved private-key credentials when enabled', () => {
  expect(requiresBiometricForSavedKey({ authMode: 'key' }, true)).toBe(true);
  expect(requiresBiometricForSavedKey({ authMode: 'password' }, true)).toBe(
    false,
  );
  expect(requiresBiometricForSavedKey({ authMode: 'key' }, false)).toBe(false);
});

test('protects every private-key SSH connection while enabled', () => {
  expect(requiresBiometricForKeyUse({ authMode: 'key' }, true)).toBe(true);
  expect(requiresBiometricForKeyUse({ authMode: 'password' }, true)).toBe(
    false,
  );
  expect(requiresBiometricForKeyUse({ authMode: 'key' }, false)).toBe(false);
});
