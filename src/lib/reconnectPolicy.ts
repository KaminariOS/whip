export type ReconnectDecision =
  | { action: 'retry'; attempt: number; delayMs: number }
  | { action: 'stop'; attempts: number };

export type ReconnectRecoveryTrigger = 'app-resume' | 'network-change';

export const MAX_RECONNECT_ATTEMPTS = 5;

const INITIAL_RECONNECT_DELAY_MS = 750;
const MAX_RECONNECT_DELAY_MS = 8000;

/** Returns capped exponential backoff with equal jitter for a one-based retry. */
export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const upperBound = Math.min(
    MAX_RECONNECT_DELAY_MS,
    INITIAL_RECONNECT_DELAY_MS * (2 ** (attempt - 1)),
  );

  // Keep retries progressive while spreading clients across the latter half
  // of each backoff window after a shared network or server outage.
  return Math.round(upperBound * (0.5 + random() * 0.5));
}

/**
 * Advances a reconnect sequence after a failure. `completedAttempts` is zero
 * before the first retry and should be reset to zero after a successful
 * connection.
 */
export function nextReconnect(
  completedAttempts: number,
  random: () => number = Math.random,
): ReconnectDecision {
  const attempt = completedAttempts + 1;
  return attempt > MAX_RECONNECT_ATTEMPTS
    ? { action: 'stop', attempts: completedAttempts }
    : { action: 'retry', attempt, delayMs: reconnectDelay(attempt, random) };
}

/**
 * A network change always invalidates the transport. App resume only needs to
 * restart a sequence that already exhausted its bounded foreground retries.
 */
export function shouldRestartReconnect(
  completedAttempts: number,
  trigger: ReconnectRecoveryTrigger,
): boolean {
  return trigger === 'network-change'
    || completedAttempts >= MAX_RECONNECT_ATTEMPTS;
}
