export const RANCHER_TRIAL_DURATION_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1_000;
export const RANCHER_TRIAL_DURATION_MS =
  RANCHER_TRIAL_DURATION_DAYS * DAY_MS;

// Existing installs are not silently enrolled when the trial ships.
export const RANCHER_TRIAL_ELIGIBILITY_START_MS = Date.parse(
  '2026-08-30T06:05:12.000Z',
);

export interface RancherTrialSnapshot {
  isActive: boolean;
  startedAt: Date | null;
  endsAt: Date | null;
  daysRemaining: number;
}

export const INACTIVE_RANCHER_TRIAL: RancherTrialSnapshot = {
  isActive: false,
  startedAt: null,
  endsAt: null,
  daysRemaining: 0,
};

export function resolveRancherTrial(
  installationTime: Date | null,
  now = new Date(),
): RancherTrialSnapshot {
  const installationTimeMs = installationTime?.getTime() ?? Number.NaN;
  const nowMs = now.getTime();
  if (
    !Number.isFinite(installationTimeMs)
    || !Number.isFinite(nowMs)
    || installationTimeMs < RANCHER_TRIAL_ELIGIBILITY_START_MS
    || installationTimeMs > nowMs
  ) return INACTIVE_RANCHER_TRIAL;

  const endsAtMs = installationTimeMs + RANCHER_TRIAL_DURATION_MS;
  if (nowMs >= endsAtMs) {
    return {
      isActive: false,
      startedAt: new Date(installationTimeMs),
      endsAt: new Date(endsAtMs),
      daysRemaining: 0,
    };
  }

  return {
    isActive: true,
    startedAt: new Date(installationTimeMs),
    endsAt: new Date(endsAtMs),
    daysRemaining: Math.ceil((endsAtMs - nowMs) / DAY_MS),
  };
}
