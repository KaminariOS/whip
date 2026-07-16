export interface ReconnectPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

export type ReconnectDecision =
  | { action: 'retry'; attempt: number; delayMs: number }
  | { action: 'stop'; attempts: number };

export const defaultReconnectPolicy: Readonly<ReconnectPolicy> = {
  maxAttempts: 5,
  initialDelayMs: 750,
  multiplier: 2,
  maxDelayMs: 8000,
};

function assertPolicy(policy: ReconnectPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 0) {
    throw new RangeError('maxAttempts must be a non-negative integer');
  }
  if (!Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0) {
    throw new RangeError('initialDelayMs must be a non-negative finite number');
  }
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) {
    throw new RangeError('multiplier must be a finite number greater than or equal to 1');
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs) {
    throw new RangeError('maxDelayMs must be finite and at least initialDelayMs');
  }
}

/** Returns the bounded delay for a one-based retry attempt. */
export function reconnectDelay(
  attempt: number,
  policy: ReconnectPolicy = defaultReconnectPolicy,
): number {
  assertPolicy(policy);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be a positive integer');
  }

  return Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * (policy.multiplier ** (attempt - 1)),
  );
}

/**
 * Advances a reconnect sequence after a failure. `completedAttempts` is zero
 * before the first retry and should be reset to zero after a successful
 * connection.
 */
export function nextReconnect(
  completedAttempts: number,
  policy: ReconnectPolicy = defaultReconnectPolicy,
): ReconnectDecision {
  assertPolicy(policy);
  if (!Number.isInteger(completedAttempts) || completedAttempts < 0) {
    throw new RangeError('completedAttempts must be a non-negative integer');
  }

  const attempt = completedAttempts + 1;
  return attempt > policy.maxAttempts
    ? { action: 'stop', attempts: completedAttempts }
    : { action: 'retry', attempt, delayMs: reconnectDelay(attempt, policy) };
}
