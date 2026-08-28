import { useCallback, useEffect, useRef, useState } from 'react';

import {
  nextRemoteFileSort,
  type RemoteFileSortField,
} from '../lib/remoteFiles';
import {
  defaultRemoteFilePreferences,
  loadRemoteFilePreferences,
  saveRemoteFilePreferences,
} from '../services/remoteFilePreferences';
import { reportBackgroundFailure } from '../services/backgroundOperations';

/** Owns hydration and persistence for the remote browser's view preferences. */
export function useRemoteFileViewPreferences() {
  const [preferences, setPreferences] = useState(defaultRemoteFilePreferences);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => {
    let active = true;
    reportBackgroundFailure(
      loadRemoteFilePreferences().then(value => {
        if (!active) return;
        preferencesRef.current = value;
        setPreferences(value);
      }),
      'remote-file-preferences-load',
    );
    return () => {
      active = false;
    };
  }, []);

  const setShowHiddenFiles = useCallback((showHiddenFiles: boolean) => {
    const next = { ...preferencesRef.current, showHiddenFiles };
    preferencesRef.current = next;
    setPreferences(next);
    reportBackgroundFailure(
      saveRemoteFilePreferences(next),
      'remote-file-preferences-persist',
    );
  }, []);

  const selectSortField = useCallback((field: RemoteFileSortField) => {
    const current = preferencesRef.current;
    const sort = nextRemoteFileSort(
      current.sortField,
      current.sortDirection,
      field,
    );
    const next = {
      ...current,
      sortField: sort.field,
      sortDirection: sort.direction,
    };
    preferencesRef.current = next;
    setPreferences(next);
    reportBackgroundFailure(
      saveRemoteFilePreferences(next),
      'remote-file-preferences-persist',
    );
  }, []);

  return {
    ...preferences,
    setShowHiddenFiles,
    selectSortField,
  };
}
