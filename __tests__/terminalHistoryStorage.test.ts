jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadTerminalHistory,
  saveTerminalHistory,
  TERMINAL_HISTORY_STORAGE_KEY,
} from '../src/services/terminalHistory';

const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);

beforeEach(() => {
  mockGetItem.mockReset();
  mockSetItem.mockReset();
});

test('loads valid unique terminal history entries', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify(['newest', '', 'older', 'newest', 42]));

  await expect(loadTerminalHistory()).resolves.toEqual(['newest', 'older']);
  expect(mockGetItem).toHaveBeenCalledWith(TERMINAL_HISTORY_STORAGE_KEY);
});

test('recovers from malformed terminal history', async () => {
  mockGetItem.mockResolvedValue('{not json');
  await expect(loadTerminalHistory()).resolves.toEqual([]);
});

test('saves normalized terminal history', async () => {
  await saveTerminalHistory(['newest', 'older', 'newest']);

  expect(mockSetItem).toHaveBeenCalledWith(
    TERMINAL_HISTORY_STORAGE_KEY,
    JSON.stringify(['newest', 'older']),
  );
});
