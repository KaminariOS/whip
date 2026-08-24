import {
  HOST_LIVENESS_FAILURES_BEFORE_RECONNECT,
  nextHostLivenessFailure,
} from '../src/lib/hostLiveness';

describe('host liveness failures', () => {
  test('requires repeated ordinary probe failures before reconnecting', () => {
    const first = nextHostLivenessFailure(0);
    const second = nextHostLivenessFailure(first.failures);

    expect(HOST_LIVENESS_FAILURES_BEFORE_RECONNECT).toBe(2);
    expect(first).toEqual({ failures: 1, reconnect: false });
    expect(second).toEqual({ failures: 2, reconnect: true });
  });

  test('reconnects after one failed probe when independent stale evidence exists', () => {
    expect(nextHostLivenessFailure(0, true)).toEqual({
      failures: 1,
      reconnect: true,
    });
  });

  test('sanitizes an invalid prior failure count', () => {
    expect(nextHostLivenessFailure(Number.NaN)).toEqual({
      failures: 1,
      reconnect: false,
    });
  });
});
