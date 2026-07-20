import type { AppearancePreference } from '../services/devicePreferences';

export type ReactNativeColorScheme = 'light' | 'dark' | 'unspecified';

export function resolveColorScheme(preference: AppearancePreference): ReactNativeColorScheme {
  return preference === 'system' ? 'unspecified' : preference;
}
