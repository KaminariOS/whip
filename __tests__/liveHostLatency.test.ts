import {
  clearLiveHostLatency,
  recordLiveHostLatency,
  type LiveHostTelemetryState,
} from '../src/hooks/useLiveHostTelemetry';
import {
  runtimeStateInvalidatesLiveHostLatency,
  visibleLiveHostLatency,
} from '../src/lib/liveHostLatency';

describe('live host SSH latency visibility', () => {
  test('shows a recorded RTT while the SSH session is connected', () => {
    expect(visibleLiveHostLatency('connected', 42)).toBe(42);
  });

  test('shows a recorded RTT when the Herdr session is ready', () => {
    expect(visibleLiveHostLatency('ready', 42)).toBe(42);
  });

  test.each([
    'connecting',
    'reconnecting',
    'disconnected',
    'error',
  ] as const)('does not expose stale RTT while the session is %s', status => {
    expect(visibleLiveHostLatency(status, 42)).toBeNull();
  });

  test('shows unavailable latency when SSH is connected without a sample', () => {
    expect(visibleLiveHostLatency('connected', null)).toBeNull();
  });

  test('does not require Herdr readiness to retain an SSH RTT', () => {
    const herdrStillInitializing = 'connected' as const;

    expect(visibleLiveHostLatency(herdrStillInitializing, 27)).toBe(27);
  });

  test.each([
    'reconnecting',
    'disconnecting',
    'disconnected',
    'failed',
  ] as const)('treats native SSH state %s as latency-invalidating', state => {
    expect(runtimeStateInvalidatesLiveHostLatency(state)).toBe(true);
  });

  test.each(['connecting', 'connected'] as const)(
    'does not treat native SSH state %s as recovery invalidation',
    state => {
      expect(runtimeStateInvalidatesLiveHostLatency(state)).toBe(false);
    },
  );

  test('clears stale RTT for SSH recovery and restores it after a new sample', () => {
    const initial: LiveHostTelemetryState = new Map();
    const healthy = recordLiveHostLatency(initial, 'session-1', 42);
    const reconnecting = clearLiveHostLatency(healthy, 'session-1');

    expect(visibleLiveHostLatency('reconnecting', 42)).toBeNull();
    expect(reconnecting.get('session-1')).toBeUndefined();
    expect(visibleLiveHostLatency('connected', null)).toBeNull();

    const recovered = recordLiveHostLatency(
      reconnecting,
      'session-1',
      31,
    );
    expect(
      visibleLiveHostLatency(
        'connected',
        recovered.get('session-1')?.latencyMs ?? null,
      ),
    ).toBe(31);
  });
});
