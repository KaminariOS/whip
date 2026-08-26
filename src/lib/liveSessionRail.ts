import type { LiveHostConnectionStatus } from '../liveHostSessions';

export type LiveSessionRailIndicator = 'agent' | 'progress' | 'offline';

export function liveSessionRailIndicator(
  status: LiveHostConnectionStatus,
): LiveSessionRailIndicator {
  if (status === 'connecting' || status === 'reconnecting') return 'progress';
  if (status === 'disconnected' || status === 'error') return 'offline';
  return 'agent';
}
