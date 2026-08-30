export type WhipTier = 'cowboy' | 'rancher';

export const developerMembershipStates = [
  'cowboy',
  'free-trial',
  'rancher',
] as const;
export type DeveloperMembershipState =
  (typeof developerMembershipStates)[number];

export const DEFAULT_WHIP_TIER: WhipTier = 'cowboy';
export const DEFAULT_DEVELOPER_MEMBERSHIP_STATE: DeveloperMembershipState =
  'cowboy';

export function resolveAccessTier(
  developerMembershipState: DeveloperMembershipState | null,
): WhipTier {
  return developerMembershipState === 'cowboy' ? 'cowboy' : 'rancher';
}

export function isDeveloperMembershipState(
  value: unknown,
): value is DeveloperMembershipState {
  return developerMembershipStates.some(state => state === value);
}
