import type { RuntimeConnectionState } from 'react-native-whip-ssh';

import type { LiveHostConnectionStatus } from '../liveHostSessions';

export function isLiveHostSshConnected(
  status: LiveHostConnectionStatus,
): boolean {
  return status === 'connected' || status === 'ready';
}

export function visibleLiveHostLatency(
  status: LiveHostConnectionStatus,
  latencyMs: number | null,
): number | null {
  return isLiveHostSshConnected(status) ? latencyMs : null;
}

export function runtimeStateInvalidatesLiveHostLatency(
  state: RuntimeConnectionState,
): boolean {
  return state === 'reconnecting'
    || state === 'disconnecting'
    || state === 'disconnected'
    || state === 'failed';
}
