import type { AppStateStatus } from 'react-native';

export type BiometricResumeAction = 'lock' | 'authenticate' | null;

export function biometricResumeAction(
  previousState: AppStateStatus,
  nextState: AppStateStatus,
  enabled: boolean,
  preferencesLoaded: boolean,
): BiometricResumeAction {
  if (!enabled || !preferencesLoaded) return null;
  if (nextState !== 'active') return 'lock';
  return previousState !== 'active' ? 'authenticate' : null;
}
