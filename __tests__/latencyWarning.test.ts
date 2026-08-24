import {
  initialLatencyWarningState,
  nextLatencyWarningState,
  shouldDisplayLatencyWarning,
} from '../src/lib/latencyWarning';

describe('latency warning hysteresis', () => {
  test('activates after two samples at or above 200 ms', () => {
    const first = nextLatencyWarningState(initialLatencyWarningState, 200);
    expect(first.active).toBe(false);
    expect(nextLatencyWarningState(first, 245).active).toBe(true);
  });

  test('resets a pending warning when latency falls below 200 ms', () => {
    const first = nextLatencyWarningState(initialLatencyWarningState, 250);
    const recovered = nextLatencyWarningState(first, 199);

    expect(recovered).toBe(initialLatencyWarningState);
  });

  test('stays active between thresholds and recovers after two samples at or below 150 ms', () => {
    const high = nextLatencyWarningState(
      nextLatencyWarningState(initialLatencyWarningState, 200),
      200,
    );
    const middle = nextLatencyWarningState(high, 175);
    const firstRecovery = nextLatencyWarningState(middle, 150);

    expect(middle.active).toBe(true);
    expect(firstRecovery.active).toBe(true);
    expect(nextLatencyWarningState(firstRecovery, 125)).toBe(initialLatencyWarningState);
  });

  test('clears pending state when a latency reading is unavailable', () => {
    const pending = nextLatencyWarningState(initialLatencyWarningState, 220);

    expect(nextLatencyWarningState(pending, null)).toBe(initialLatencyWarningState);
  });

  test('does not display a latched warning with a healthy current reading', () => {
    expect(shouldDisplayLatencyWarning(true, 5)).toBe(false);
    expect(shouldDisplayLatencyWarning(true, 150)).toBe(false);
    expect(shouldDisplayLatencyWarning(true, 175)).toBe(true);
    expect(shouldDisplayLatencyWarning(false, 500)).toBe(false);
  });
});
