export type RefreshResult<T> =
  | { status: 'applied'; value: T }
  | { status: 'stale' }
  | { status: 'failed'; error: unknown };

export interface RefreshCoordinator<T> {
  /**
   * Runs a refresh without overlapping an in-flight request. Calls received
   * while a refresh is active are coalesced into one follow-up refresh.
   */
  request: () => Promise<RefreshResult<T>>;

  /**
   * Rejects results from the current generation. Use this before replacing or
   * disconnecting the client that the loader reads from.
   */
  invalidate: () => void;

  isRefreshing: () => boolean;
}

interface PendingRefresh<T> {
  generation: number;
  listeners: Array<(result: RefreshResult<T>) => void>;
}

/**
 * Coordinates snapshot-style reads where only the newest connection
 * generation may commit data to application state.
 *
 * `commit` is deliberately synchronous: the generation check and state commit
 * remain one turn of JavaScript, leaving no await boundary where a result can
 * become stale.
 */
export function createRefreshCoordinator<T>(
  load: () => Promise<T>,
  commit: (value: T) => void,
): RefreshCoordinator<T> {
  let generation = 0;
  let active: Promise<RefreshResult<T>> | null = null;
  let pending: PendingRefresh<T> | null = null;

  const resolvePending = (queued: PendingRefresh<T>, result: RefreshResult<T>) => {
    for (const listener of queued.listeners) listener(result);
  };

  const run = (runGeneration: number): Promise<RefreshResult<T>> => {
    const result = (async (): Promise<RefreshResult<T>> => {
      if (runGeneration !== generation) return { status: 'stale' };

      try {
        const value = await load();
        if (runGeneration !== generation) return { status: 'stale' };
        commit(value);
        return { status: 'applied', value };
      } catch (error) {
        return runGeneration === generation
          ? { status: 'failed', error }
          : { status: 'stale' };
      }
    })();

    active = result;
    result.finally(() => {
      if (active === result) active = null;

      const queued = pending;
      pending = null;
      if (!queued) return;

      if (queued.generation !== generation) {
        resolvePending(queued, { status: 'stale' });
        return;
      }

      run(queued.generation).then(next => resolvePending(queued, next));
    });
    return result;
  };

  return {
    request: () => {
      if (!active) return run(generation);

      return new Promise<RefreshResult<T>>(resolve => {
        if (pending?.generation === generation) {
          pending.listeners.push(resolve);
          return;
        }

        if (pending) resolvePending(pending, { status: 'stale' });
        pending = { generation, listeners: [resolve] };
      });
    },
    invalidate: () => {
      generation += 1;
      if (pending) {
        resolvePending(pending, { status: 'stale' });
        pending = null;
      }
    },
    isRefreshing: () => active !== null,
  };
}
