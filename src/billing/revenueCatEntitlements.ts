import { DEFAULT_WHIP_TIER, type WhipTier } from './tiers';

export const RANCHER_ENTITLEMENT_IDENTIFIER = 'whip_rancher';

interface RevenueCatEntitlementLike {
  isActive: boolean;
}

export interface RevenueCatCustomerInfoLike {
  entitlements: {
    active: Readonly<Record<string, RevenueCatEntitlementLike>>;
  };
}

export interface WhipEntitlementSnapshot {
  tier: WhipTier;
}

export function resolveWhipEntitlements(
  customerInfo: RevenueCatCustomerInfoLike | null,
): WhipEntitlementSnapshot {
  const rancher =
    customerInfo?.entitlements.active[RANCHER_ENTITLEMENT_IDENTIFIER];
  if (!rancher?.isActive) {
    return {
      tier: DEFAULT_WHIP_TIER,
    };
  }

  return {
    tier: 'rancher',
  };
}
