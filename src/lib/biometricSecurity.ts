import type { HostProfile } from '../types';

type KeyProfile = Pick<HostProfile, 'authMode'>;

export function requiresBiometricForKeyUse(
  profile: KeyProfile,
  biometricForKeys: boolean,
): boolean {
  return biometricForKeys && profile.authMode === 'key';
}

export function requiresBiometricForSavedKey(
  profile: KeyProfile,
  biometricForKeys: boolean,
): boolean {
  return requiresBiometricForKeyUse(profile, biometricForKeys);
}
