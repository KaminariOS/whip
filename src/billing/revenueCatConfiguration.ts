import { isUnknownRecord } from '../lib/unknown';

export function revenueCatPublicSdkKey(
  extra: unknown,
  platform: string,
  allowTestStore: boolean,
): string | null {
  const value = isUnknownRecord(extra)
    ? platform === 'ios'
      ? extra.revenueCatIosPublicSdkKey
      : platform === 'android'
        ? extra.revenueCatAndroidPublicSdkKey
        : null
    : null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  const testValue = isUnknownRecord(extra)
    ? extra.revenueCatTestPublicSdkKey
    : undefined;
  return allowTestStore && typeof testValue === 'string' && testValue.trim()
    ? testValue.trim()
    : null;
}
