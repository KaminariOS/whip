import { hasCapability } from './capabilities';
import type { WhipTier } from './tiers';
import type { DevicePreferences } from '../services/devicePreferences';

/**
 * Applies entitlement-aware cosmetic fallbacks without changing the stored
 * preference object. Restoring Rancher therefore restores the user's choices.
 */
export function effectiveDevicePreferences(
  stored: DevicePreferences,
  tier: WhipTier,
): DevicePreferences {
  const appBackgroundEnabled = hasCapability(tier, 'custom-app-background');
  const terminalBackgroundEnabled = hasCapability(
    tier,
    'custom-terminal-background',
  );
  const glassEnabled = hasCapability(tier, 'glass');

  if (appBackgroundEnabled && terminalBackgroundEnabled && glassEnabled) {
    return stored;
  }

  return {
    ...stored,
    appBackgroundImageUri: appBackgroundEnabled
      ? stored.appBackgroundImageUri
      : null,
    appGlassEnabled: glassEnabled ? stored.appGlassEnabled : false,
    terminal: terminalBackgroundEnabled
      ? stored.terminal
      : { ...stored.terminal, backgroundImageUri: null },
  };
}
