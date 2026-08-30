import { hasCapability } from './capabilities';
import { RANCHER_TRIAL_DURATION_MS } from './rancherTrial';
import {
  resolveAccessTier,
  type DeveloperMembershipState,
} from './tiers';
import type { WhipEntitlementsController } from './useWhipEntitlements';

/**
 * Applies a developer-only membership state without creating or persisting a
 * RevenueCat entitlement. Purchase and restore operations remain wired to the
 * live controller so the purchase screen can still be exercised.
 */
export function simulateDeveloperMembership(
  controller: WhipEntitlementsController,
  state: DeveloperMembershipState,
  nowMs = Date.now(),
): WhipEntitlementsController {
  const tier = resolveAccessTier(state);
  const isTrialActive = state === 'free-trial';

  return {
    ...controller,
    tier,
    hasCapability: capability => hasCapability(tier, capability),
    hasLifetimeAccess: state === 'rancher',
    isTrialActive,
    trialDaysRemaining: isTrialActive ? 5 : 0,
    trialEndsAt: isTrialActive
      ? new Date(nowMs + RANCHER_TRIAL_DURATION_MS)
      : null,
  };
}
