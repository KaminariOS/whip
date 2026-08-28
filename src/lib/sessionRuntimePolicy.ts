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
    disconnect: () => Promise<void>;
  };
}

// Module scope keeps teardown visible across session-manager unmount/remount cycles.
const runtimeDestructions = new Map<string, Promise<void>>();

export function destroyRuntime(
  runtimeId: string,
  runtime: ReleasableRuntime,
): Promise<void> {
  const previous = runtimeDestructions.get(runtimeId) ?? Promise.resolve();
  const destruction = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await runtime.client.releaseAllTerminals();
      } finally {
        await runtime.client.disconnect();
      }
    });
  runtimeDestructions.set(runtimeId, destruction);
  destruction.finally(() => {
    if (runtimeDestructions.get(runtimeId) === destruction) {
      runtimeDestructions.delete(runtimeId);
    }
  }).catch(() => undefined);
  return destruction;
}

export function waitForRuntimeDestruction(runtimeId: string): Promise<void> {
  return runtimeDestructions.get(runtimeId) ?? Promise.resolve();
}

export function disposeRuntimeMap<Runtime extends ReleasableRuntime>(
  target: Map<string, Runtime>,
): Promise<void> {
  const destructions = [...target].map(([runtimeId, runtime]) =>
    destroyRuntime(runtimeId, runtime),
  );
  target.clear();
  return Promise.all(destructions).then(() => undefined);
}
