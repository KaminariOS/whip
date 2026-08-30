import type { WhipTier } from './tiers';

export type WhipCapability =
  | 'custom-app-background'
  | 'custom-terminal-background'
  | 'glass';

const TIER_CAPABILITIES: Readonly<Record<WhipTier, ReadonlySet<WhipCapability>>> = {
  cowboy: new Set(),
  rancher: new Set([
    'custom-app-background',
    'custom-terminal-background',
    'glass',
  ]),
};

export function hasCapability(
  tier: WhipTier,
  capability: WhipCapability,
): boolean {
  return TIER_CAPABILITIES[tier].has(capability);
}
