import AsyncStorage from '@react-native-async-storage/async-storage';

import { parseTerminalHistory } from '../lib/terminalHistory';

export const TERMINAL_HISTORY_STORAGE_KEY = 'herdr.terminal.history.v1';

export async function loadTerminalHistory(): Promise<string[]> {
  const value = await AsyncStorage.getItem(TERMINAL_HISTORY_STORAGE_KEY);
  return terminalHistoryFromStorage(value);
}

export function terminalHistoryFromStorage(value: string | null): string[] {
  if (!value) return [];
  try {
    return parseTerminalHistory(JSON.parse(value));
  } catch {
    return [];
  }
}

export async function saveTerminalHistory(entries: readonly string[]): Promise<void> {
  await AsyncStorage.setItem(
    TERMINAL_HISTORY_STORAGE_KEY,
    JSON.stringify(parseTerminalHistory(entries)),
  );
}
