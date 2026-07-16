jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  defaultDevicePreferences,
  loadDevicePreferences,
  saveDevicePreferences,
} from '../src/services/devicePreferences';

const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);

beforeEach(() => {
  mockGetItem.mockReset();
  mockSetItem.mockReset();
});

test('terminal preference defaults match the mobile renderer', () => {
  expect(defaultDevicePreferences.terminal).toEqual({
    fontSize: 8,
    scrollback: 5000,
    cursorBlink: true,
  });
  expect(defaultDevicePreferences.lastTab).toBe('hosts');
});

test('migrates the old 11px mobile default to the usable 8px geometry', async () => {
  mockGetItem
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(JSON.stringify({
      alertsEnabled: false,
      ttsEnabled: true,
      lastTab: 'terminal',
      terminal: { fontSize: 11, scrollback: 9000, cursorBlink: false },
    }));

  await expect(loadDevicePreferences()).resolves.toEqual({
    alertsEnabled: false,
    ttsEnabled: true,
    lastTab: 'terminal',
    terminal: { fontSize: 8, scrollback: 9000, cursorBlink: false },
  });
});

test('persists new preferences under the v3 key', async () => {
  await saveDevicePreferences(defaultDevicePreferences);
  expect(mockSetItem).toHaveBeenCalledWith(
    'herdr.device.preferences.v3',
    JSON.stringify(defaultDevicePreferences),
  );
});
