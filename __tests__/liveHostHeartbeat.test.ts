import { shouldRefreshLiveHost } from '../src/lib/liveHostHeartbeat';
import { initialLatencyWarningState } from '../src/lib/latencyWarning';
import type { LiveHostSession } from '../src/liveHostSessions';

function state(
  status: LiveHostSession['status'] = 'ready',
  syncStatus: LiveHostSession['sync']['status'] = 'synced',
): Pick<LiveHostSession, 'status' | 'sync'> {
  return {
    status,
    sync: {
      status: syncStatus,
      generation: 1,
      connectionGeneration: 1,
      revision: 1,
      freshness: syncStatus === 'synced' ? 'fresh' : syncStatus === 'stale' ? 'stale' : 'loading',
      error: null,
      lastSyncedAt: null,
      latencyMs: null,
      latencyWarning: initialLatencyWarningState,
    },
  };
}

describe('live host heartbeat', () => {
  it('skips healthy event-backed sessions during frequent health checks', () => {
    expect(shouldRefreshLiveHost(state(), false)).toBe(false);
  });

  it('refreshes stale connections and sessions without an event stream', () => {
    expect(
      shouldRefreshLiveHost(state('reconnecting', 'stale'), false),
    ).toBe(true);
  });

  it('periodically reconciles healthy sessions without duplicating in-flight work', () => {
    expect(shouldRefreshLiveHost(state(), true)).toBe(true);
    expect(
      shouldRefreshLiveHost(state('connected', 'syncing'), true),
    ).toBe(false);
    expect(
      shouldRefreshLiveHost(state('connecting', 'idle'), true),
    ).toBe(false);
  });

  it('keeps transport-connected hosts refreshing until hydration marks them ready', () => {
    expect(shouldRefreshLiveHost(state('connected'), false)).toBe(true);
  });
});
