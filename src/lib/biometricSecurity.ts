import type { HostProfile } from '../types';

type SavedCredentialProfile = Pick<HostProfile, 'authMode' | 'rememberCredentials'>;
type KeyProfile = Pick<HostProfile, 'authMode'>;

export function requiresBiometricForKeyUse(
  profile: KeyProfile,
  biometricForKeys: boolean,
): boolean {
  return biometricForKeys && profile.authMode === 'key';
}

export function requiresBiometricForSavedKey(
  profile: SavedCredentialProfile,
  biometricForKeys: boolean,
): boolean {
  return requiresBiometricForKeyUse(profile, biometricForKeys) && profile.rememberCredentials;
}
