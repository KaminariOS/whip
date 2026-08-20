import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  RemoteFileSortDirection,
  RemoteFileSortField,
} from '@/src/lib/remoteFiles';

export const REMOTE_FILE_PREFERENCES_KEY = 'whip.remote-files.preferences.v1';

export interface RemoteFilePreferences {
  showHiddenFiles: boolean;
  sortField: RemoteFileSortField;
  sortDirection: RemoteFileSortDirection;
}

export const defaultRemoteFilePreferences: RemoteFilePreferences = {
  showHiddenFiles: false,
  sortField: 'name',
  sortDirection: 'ascending',
};

export async function loadRemoteFilePreferences(): Promise<RemoteFilePreferences> {
  try {
    const value = await AsyncStorage.getItem(REMOTE_FILE_PREFERENCES_KEY);
    if (!value) return defaultRemoteFilePreferences;
    const parsed = JSON.parse(value) as Partial<RemoteFilePreferences>;
    return {
      showHiddenFiles:
        typeof parsed.showHiddenFiles === 'boolean'
          ? parsed.showHiddenFiles
          : defaultRemoteFilePreferences.showHiddenFiles,
      sortField: isSortField(parsed.sortField)
        ? parsed.sortField
        : defaultRemoteFilePreferences.sortField,
      sortDirection: isSortDirection(parsed.sortDirection)
        ? parsed.sortDirection
        : defaultRemoteFilePreferences.sortDirection,
    };
  } catch {
    return defaultRemoteFilePreferences;
  }
}

export async function saveRemoteFilePreferences(
  preferences: RemoteFilePreferences,
): Promise<void> {
  await AsyncStorage.setItem(
    REMOTE_FILE_PREFERENCES_KEY,
    JSON.stringify(preferences),
  );
}

function isSortField(value: unknown): value is RemoteFileSortField {
  return value === 'name' || value === 'modified' || value === 'size';
}

function isSortDirection(value: unknown): value is RemoteFileSortDirection {
  return value === 'ascending' || value === 'descending';
}
