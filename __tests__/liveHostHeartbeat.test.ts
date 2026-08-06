import { shouldRefreshLiveHost } from '../src/lib/liveHostHeartbeat';
import type { LiveHostSession } from '../src/liveHostSessions';

function state(
  status: LiveHostSession['status'] = 'connected',
  syncStatus: LiveHostSession['sync']['status'] = 'synced',
): Pick<LiveHostSession, 'status' | 'sync'> {
  return {
    status,
    sync: {
      status: syncStatus,
      generation: 1,
      error: null,
      lastSyncedAt: null,
      latencyMs: null,
    },
  };
}

describe('live host heartbeat', () => {
  it('skips healthy event-backed sessions during frequent health checks', () => {
    expect(shouldRefreshLiveHost(state(), true, false)).toBe(false);
  });

  it('refreshes stale connections and sessions without an event stream', () => {
    expect(
      shouldRefreshLiveHost(state('reconnecting', 'stale'), false, false),
    ).toBe(true);
    expect(shouldRefreshLiveHost(state(), false, false)).toBe(true);
  });

  it('periodically reconciles healthy sessions without duplicating in-flight work', () => {
    expect(shouldRefreshLiveHost(state(), true, true)).toBe(true);
    expect(
      shouldRefreshLiveHost(state('connected', 'syncing'), true, true),
    ).toBe(false);
    expect(
      shouldRefreshLiveHost(state('connecting', 'idle'), false, true),
    ).toBe(false);
  });
});
