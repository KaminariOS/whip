import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addTerminalHistoryEntry,
  removeTerminalHistoryEntries,
  shouldPersistTerminalHistory,
} from '../lib/terminalHistory';
import {
  loadTerminalHistory,
  saveTerminalHistory,
  terminalHistoryFromStorage,
} from '../services/terminalHistory';
import type { StartupStorageSnapshot } from '../services/startupStorage';
import type { LoadState } from './useStartupStorage';

interface TerminalHistoryOptions {
  startupStorage: LoadState<StartupStorageSnapshot>;
  deferredHydrationReady: boolean;
}

/** Owns terminal command history hydration, mutation, and guarded persistence. */
export function useTerminalHistory({
  startupStorage,
  deferredHydrationReady,
}: TerminalHistoryOptions) {
  const [entries, setEntries] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [safeToPersist, setSafeToPersist] = useState(false);
  const hydrationStartedRef = useRef(false);

  useEffect(() => {
    if (!deferredHydrationReady || hydrationStartedRef.current) return;
    hydrationStartedRef.current = true;
    const load =
      startupStorage.status === 'loaded'
        ? terminalHistoryFromStorage(startupStorage.value.terminalHistory)
        : loadTerminalHistory();
    Promise.resolve(load)
      .then(value => {
        setEntries(value);
        setSafeToPersist(true);
      })
      .catch(() => {
        // Keep failed hydration distinct from a successfully loaded empty list.
        setEntries([]);
        setSafeToPersist(false);
      })
      .finally(() => setLoaded(true));
  }, [deferredHydrationReady, startupStorage]);

  useEffect(() => {
    if (!shouldPersistTerminalHistory(loaded, safeToPersist)) return;
    saveTerminalHistory(entries).catch(() => undefined);
  }, [entries, loaded, safeToPersist]);

  const record = useCallback((entry: string) => {
    setEntries(current => addTerminalHistoryEntry(current, entry));
  }, []);

  const remove = useCallback((values: readonly string[]) => {
    setEntries(current => removeTerminalHistoryEntries(current, values));
  }, []);

  return useMemo(
    () => ({ entries, loaded, safeToPersist, record, remove }),
    [entries, loaded, record, remove, safeToPersist],
  );
}
