export type WhipTier = 'cowboy' | 'rancher';

export const DEFAULT_WHIP_TIER: WhipTier = 'cowboy';

export function resolveAccessTier(
  entitlementTier: WhipTier,
  rancherPaymentsEnabled: boolean,
): WhipTier {
  return rancherPaymentsEnabled ? entitlementTier : 'rancher';
}
