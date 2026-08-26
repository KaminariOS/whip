import type { LiveHostSession } from '@/src/liveHostSessions';

export function shouldRefreshLiveHost(
  session: Pick<LiveHostSession, 'status' | 'sync'>,
  reconcile: boolean,
): boolean {
  if (session.status === 'connecting' || session.sync.status === 'syncing')
    return false;
  if (reconcile) return true;
  return (
    session.status !== 'ready' ||
    session.sync.freshness !== 'fresh'
  );
}
