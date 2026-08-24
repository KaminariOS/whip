export const HOST_LIVENESS_FAILURES_BEFORE_RECONNECT = 2;

export interface HostLivenessFailureDecision {
  failures: number;
  reconnect: boolean;
}

/**
 * Require two ordinary probe failures to avoid reconnecting for one transient
 * scheduler stall. A closed event stream or foreground resume can request an
 * immediate decision because it supplies independent evidence of staleness.
 */
export function nextHostLivenessFailure(
  previousFailures: number,
  reconnectImmediately = false,
): HostLivenessFailureDecision {
  const normalizedFailures = Number.isFinite(previousFailures)
    ? Math.max(0, Math.floor(previousFailures))
    : 0;
  const failures = normalizedFailures + 1;
  return {
    failures,
    reconnect: reconnectImmediately
      || failures >= HOST_LIVENESS_FAILURES_BEFORE_RECONNECT,
  };
}
