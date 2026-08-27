import { useEffect, useState } from 'react';

import {
  readStartupStorage,
  type StartupStorageSnapshot,
} from '../services/startupStorage';
import { withAppPerformanceTrace } from '../services/performanceTrace';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'loaded'; value: T }
  | { status: 'failed'; error: unknown };

/**
 * Owns the one-shot startup multi-read. A failed read remains distinguishable
 * from a successfully loaded store containing no values, so downstream owners
 * can choose a safe fallback without treating defaults as hydrated data.
 */
export function useStartupStorage(): LoadState<StartupStorageSnapshot> {
  const [state, setState] = useState<LoadState<StartupStorageSnapshot>>({
    status: 'loading',
  });

  useEffect(() => {
    let active = true;
    withAppPerformanceTrace('Whip startup store: multi-get', readStartupStorage)
      .then(value => {
        if (active) setState({ status: 'loaded', value });
      })
      .catch(error => {
        if (active) setState({ status: 'failed', error });
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
