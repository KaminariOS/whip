export const HIGH_LATENCY_TRIGGER_MS = 200;
export const HIGH_LATENCY_RECOVERY_MS = 150;
export const LATENCY_WARNING_REQUIRED_SAMPLES = 2;

export interface LatencyWarningState {
  active: boolean;
  highSamples: number;
  recoverySamples: number;
}

export const initialLatencyWarningState: LatencyWarningState = {
  active: false,
  highSamples: 0,
  recoverySamples: 0,
};

/**
 * Keep recovery hysteresis in state without rendering a contradictory warning
 * for a reading that is already healthy.
 */
export function shouldDisplayLatencyWarning(
  active: boolean,
  latencyMs: number | null,
): boolean {
  return (
    active
    && latencyMs !== null
    && Number.isFinite(latencyMs)
    && latencyMs > HIGH_LATENCY_RECOVERY_MS
  );
}

/**
 * Requires sustained high latency to show the warning and sustained recovery
 * to hide it. The gap between the two thresholds prevents boundary jitter.
 */
export function nextLatencyWarningState(
  state: LatencyWarningState,
  latencyMs: number | null,
): LatencyWarningState {
  if (latencyMs === null || !Number.isFinite(latencyMs) || latencyMs <= 0) {
    return state.active || state.highSamples > 0 || state.recoverySamples > 0
      ? initialLatencyWarningState
      : state;
  }

  if (!state.active) {
    if (latencyMs < HIGH_LATENCY_TRIGGER_MS) {
      return state.highSamples === 0 ? state : initialLatencyWarningState;
    }
    const highSamples = state.highSamples + 1;
    return highSamples >= LATENCY_WARNING_REQUIRED_SAMPLES
      ? { active: true, highSamples: 0, recoverySamples: 0 }
      : { active: false, highSamples, recoverySamples: 0 };
  }

  if (latencyMs > HIGH_LATENCY_RECOVERY_MS) {
    return state.recoverySamples === 0
      ? state
      : { active: true, highSamples: 0, recoverySamples: 0 };
  }
  const recoverySamples = state.recoverySamples + 1;
  return recoverySamples >= LATENCY_WARNING_REQUIRED_SAMPLES
    ? initialLatencyWarningState
    : { active: true, highSamples: 0, recoverySamples };
}
