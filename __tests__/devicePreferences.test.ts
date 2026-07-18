jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));
jest.mock('../src/services/terminalBackground', () => ({
  migrateTerminalBackgroundImage: jest.fn(uri => Promise.resolve(uri)),
  removeTerminalBackgroundImage: jest.fn(() => Promise.resolve()),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  defaultDevicePreferences,
  loadDevicePreferences,
  saveDevicePreferences,
} from '../src/services/devicePreferences';
import {
  migrateTerminalBackgroundImage,
  removeTerminalBackgroundImage,
} from '../src/services/terminalBackground';

const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);
const mockMigrateBackground = jest.mocked(migrateTerminalBackgroundImage);
const mockRemoveBackground = jest.mocked(removeTerminalBackgroundImage);

beforeEach(() => {
  mockGetItem.mockReset();
  mockSetItem.mockReset();
  mockMigrateBackground.mockReset();
  mockMigrateBackground.mockImplementation(uri => Promise.resolve(uri));
  mockRemoveBackground.mockReset();
  mockRemoveBackground.mockResolvedValue();
});

test('terminal preference defaults match the mobile renderer', () => {
  expect(defaultDevicePreferences.terminal).toEqual({
    fontSize: 8,
    scrollback: 5000,
    cursorBlink: true,
    backgroundImageUri: null,
    backgroundDimming: 60,
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
    terminal: {
      fontSize: 8,
      scrollback: 9000,
      cursorBlink: false,
      backgroundImageUri: null,
      backgroundDimming: 60,
    },
  });
});

test('sanitizes persisted terminal background preferences', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    terminal: {
      backgroundImageUri: 'file:///data/user/0/io.github.kaminarios.whip/files/background.webp',
      backgroundOpacity: 150,
    },
  }));

  const preferences = await loadDevicePreferences();
  expect(preferences.terminal.backgroundImageUri).toBe('file:///data/user/0/io.github.kaminarios.whip/files/background.webp');
  expect(preferences.terminal.backgroundDimming).toBe(100);
});

test('persists new preferences under the v3 key', async () => {
  await saveDevicePreferences(defaultDevicePreferences);
  expect(mockSetItem).toHaveBeenCalledWith(
    'herdr.device.preferences.v3',
    JSON.stringify(defaultDevicePreferences),
  );
});

test('moves an existing terminal background into backed-up storage', async () => {
  const previousUri = 'file:///data/user/0/io.github.kaminarios.whip/files/herdr-terminal-background-1.webp';
  const backedUpUri = 'file:///data/user/0/io.github.kaminarios.whip/files/terminal-backgrounds/herdr-terminal-background-1.webp';
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { backgroundImageUri: previousUri } }));
  mockMigrateBackground.mockResolvedValueOnce(backedUpUri);

  const preferences = await loadDevicePreferences();

  expect(preferences.terminal.backgroundImageUri).toBe(backedUpUri);
  expect(mockSetItem).toHaveBeenCalledWith(
    'herdr.device.preferences.v3',
    JSON.stringify(preferences),
  );
  expect(mockRemoveBackground).toHaveBeenCalledWith(previousUri);
});
