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
    fullscreen: true,
    useModifierKeyIcons: false,
    volumeUpAction: 'none',
    volumeDownAction: 'none',
    fontSize: 8,
    scrollback: 5000,
    cursorBlink: true,
    doubleTapAction: 'tab',
    openLinksInApp: true,
    pauseResizeInBackground: true,
    backgroundImageUri: null,
    backgroundDimming: 60,
  });
  expect(defaultDevicePreferences.terminalControlUsage).toEqual({});
  expect(defaultDevicePreferences.appearance).toBe('system');
  expect(defaultDevicePreferences.language).toBe('system');
  expect(defaultDevicePreferences.biometricForKeys).toBe(false);
  expect(defaultDevicePreferences.biometricOnResume).toBe(false);
  expect(defaultDevicePreferences.keepScreenOn).toBe(false);
  expect(defaultDevicePreferences.reopenTerminalOnLaunch).toBe(false);
  expect(defaultDevicePreferences.agentCommand).toBe('opencode');
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
    biometricForKeys: false,
    biometricOnResume: false,
    appearance: 'system',
    language: 'system',
    keepScreenOn: false,
    reopenTerminalOnLaunch: false,
    agentCommand: 'opencode',
    lastTab: 'terminal',
    terminalControlUsage: {},
    terminal: {
      fullscreen: true,
      useModifierKeyIcons: false,
      volumeUpAction: 'none',
      volumeDownAction: 'none',
      fontSize: 8,
      scrollback: 9000,
      cursorBlink: false,
      doubleTapAction: 'tab',
      openLinksInApp: true,
      pauseResizeInBackground: true,
      backgroundImageUri: null,
      backgroundDimming: 60,
    },
  });
});

test('loads a configured agent command and rejects blank values', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ agentCommand: 'claude --dangerously-skip-permissions' }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    agentCommand: 'claude --dangerously-skip-permissions',
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ agentCommand: '   ' }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ agentCommand: 'opencode' });
});

test('loads biometric key protection only when explicitly enabled', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ biometricForKeys: true }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ biometricForKeys: true });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ biometricForKeys: 'yes' }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ biometricForKeys: false });
});

test('loads biometric-on-resume protection only when explicitly enabled', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ biometricOnResume: true }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ biometricOnResume: true });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ biometricOnResume: 'yes' }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ biometricOnResume: false });
});

test('loads a valid appearance preference and rejects invalid values', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ appearance: 'light' }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ appearance: 'light' });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ appearance: 'sepia' }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ appearance: 'system' });
});

test('loads a supported language preference and rejects invalid values', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ language: 'zh-Hant' }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ language: 'zh-Hant' });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ language: 'fr' }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({ language: 'system' });
});

test('loads terminal behavior toggles only when explicitly enabled', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    keepScreenOn: true,
    reopenTerminalOnLaunch: true,
  }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    keepScreenOn: true,
    reopenTerminalOnLaunch: true,
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    keepScreenOn: 'yes',
    reopenTerminalOnLaunch: 1,
  }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    keepScreenOn: false,
    reopenTerminalOnLaunch: false,
  });
});

test('loads double-tap actions and migrates the old Tab toggle', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { doubleTapAction: 'paste' } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { doubleTapAction: 'paste' },
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { doubleTapTab: false } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { doubleTapAction: 'none' },
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { doubleTapTab: true } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { doubleTapAction: 'tab' },
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { doubleTapAction: 'launch-missiles' } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { doubleTapAction: 'tab' },
  });
});

test('uses fullscreen terminals by default and allows fullscreen to be disabled', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { fullscreen: false } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { fullscreen: false },
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { fullscreen: 'no' } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { fullscreen: true },
  });
});

test('uses modifier key text by default and allows modifier key icons to be enabled', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { useModifierKeyIcons: true } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { useModifierKeyIcons: true },
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { useModifierKeyIcons: 'yes' } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { useModifierKeyIcons: false },
  });
});

test('configures volume keys independently and defaults invalid actions to volume only', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    terminal: { volumeUpAction: 'scroll', volumeDownAction: 'vertical-arrow' },
  }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { volumeUpAction: 'scroll', volumeDownAction: 'vertical-arrow' },
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    terminal: { volumeUpAction: 'louder', volumeDownAction: 1 },
  }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { volumeUpAction: 'none', volumeDownAction: 'none' },
  });
});

test('opens terminal links in app by default and allows it to be disabled', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { openLinksInApp: false } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { openLinksInApp: false },
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({ terminal: { openLinksInApp: 'no' } }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { openLinksInApp: true },
  });
});

test('pauses background resize commands by default and allows it to be disabled', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    terminal: { pauseResizeInBackground: false },
  }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { pauseResizeInBackground: false },
  });

  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    terminal: { pauseResizeInBackground: 'no' },
  }));
  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminal: { pauseResizeInBackground: true },
  });
});

test('sanitizes persisted terminal background preferences', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    terminal: {
      fontSize: 99,
      backgroundImageUri: 'file:///data/user/0/io.github.kaminarios.whip/files/background.webp',
      backgroundOpacity: 150,
    },
  }));

  const preferences = await loadDevicePreferences();
  expect(preferences.terminal.fontSize).toBe(24);
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

test('sanitizes persisted terminal control usage', async () => {
  mockGetItem.mockResolvedValueOnce(JSON.stringify({
    terminalControlUsage: {
      ctrl: 12,
      paste: 4.6,
      home: -1,
      unknown: 99,
    },
  }));

  await expect(loadDevicePreferences()).resolves.toMatchObject({
    terminalControlUsage: { ctrl: 12, paste: 5 },
  });
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
