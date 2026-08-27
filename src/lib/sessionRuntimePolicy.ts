export type ReconnectRecoveryTrigger = 'app-resume' | 'network-change';
export type SavedHostConnectionAction = 'select' | 'wait' | 'connect';

export function savedHostConnectionAction(
  status: string | undefined,
  hasRuntime: boolean,
): SavedHostConnectionAction {
  if (hasRuntime) return 'select';
  return status === 'connecting' ? 'wait' : 'connect';
}

export function shouldRestartLiveSession(
  trigger: ReconnectRecoveryTrigger,
  status: string,
): boolean {
  return (
    trigger === 'network-change' ||
    status === 'error' ||
    status === 'reconnecting'
  );
}

export function shouldRetainBackgroundRuntimes(
  platform: string,
  alertsEnabled: boolean,
  liveHostCount: number,
): boolean {
  return platform === 'android' && alertsEnabled && liveHostCount > 0;
}

export interface ReleasableRuntime {
  client: {
    releaseAllTerminals: () => Promise<unknown>;
    disconnect: () => unknown;
  };
}

export function disposeRuntimeMap<Runtime extends ReleasableRuntime>(
  target: Map<string, Runtime>,
): void {
  for (const runtime of target.values()) {
    runtime.client
      .releaseAllTerminals()
      .finally(() => runtime.client.disconnect());
  }
  target.clear();
}
