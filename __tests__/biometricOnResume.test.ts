import { biometricResumeAction } from '../src/lib/appAccess';

test('locks in the background and authenticates when returning', () => {
  expect(biometricResumeAction('active', 'background', true, true)).toBe('lock');
  expect(biometricResumeAction('background', 'active', true, true)).toBe('authenticate');
});

test('does not gate launch, disabled settings, or unloaded preferences', () => {
  expect(biometricResumeAction('active', 'active', true, true)).toBeNull();
  expect(biometricResumeAction('background', 'active', false, true)).toBeNull();
  expect(biometricResumeAction('background', 'active', true, false)).toBeNull();
});
