export function shouldEnableAppGlass(
  preferenceEnabled: boolean,
  backgroundImageUri: string | null,
): boolean {
  return preferenceEnabled && Boolean(backgroundImageUri);
}

export function appGlassBackgroundClassName(enabled: boolean): 'bg-transparent' | 'bg-background' {
  return enabled ? 'bg-transparent' : 'bg-background';
}

export function appGlassModalPresentation(
  enabled: boolean,
  platform: string,
): { transparent: boolean; presentationStyle?: 'overFullScreen' } {
  if (!enabled) return { transparent: false };
  return platform === 'ios'
    ? { transparent: true, presentationStyle: 'overFullScreen' }
    : { transparent: true };
}
