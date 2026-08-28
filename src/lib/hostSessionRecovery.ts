import type { LiveHostSession } from '../liveHostSessions';

export interface HostSessionRecoveryState {
  busy: boolean;
  error: string | null;
  session: LiveHostSession;
}

export function hostSessionRecoveryState({
  activeClient,
  activeSession,
  connectingHostIds,
  terminalVisible,
}: {
  activeClient: unknown;
  activeSession: LiveHostSession | null | undefined;
  connectingHostIds: ReadonlySet<string>;
  terminalVisible: boolean;
}): HostSessionRecoveryState | null {
  if (!terminalVisible || !activeSession || activeClient) return null;
  return {
    busy:
      activeSession.status === 'connecting' ||
      connectingHostIds.has(activeSession.hostId),
    error: activeSession.connectionError,
    session: activeSession,
  };
}
