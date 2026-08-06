import type { LiveHostSession } from '@/src/liveHostSessions';

export function shouldRefreshLiveHost(
  session: Pick<LiveHostSession, 'status' | 'sync'>,
  eventStreamOpen: boolean,
  reconcile: boolean,
): boolean {
  if (session.status === 'connecting' || session.sync.status === 'syncing')
    return false;
  if (reconcile) return true;
  return (
    session.status !== 'connected' ||
    session.sync.status !== 'synced' ||
    !eventStreamOpen
  );
}
