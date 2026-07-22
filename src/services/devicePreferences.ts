import AsyncStorage from '@react-native-async-storage/async-storage';

import { parseTerminalControlUsage, type TerminalControlUsage } from '../lib/terminalControls';
import type { AppTab } from '../types';
import {
  migrateTerminalBackgroundImage,
  removeTerminalBackgroundImage,
} from './terminalBackground';

const DEVICE_PREFERENCES_KEY = 'herdr.device.preferences.v3';
const LEGACY_DEVICE_PREFERENCES_KEYS = [
  'herdr.device.preferences.v2',
  'herdr.device.preferences.v1',
];

export interface TerminalPreferences {
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  backgroundImageUri: string | null;
  backgroundDimming: number;
}

export type AppearancePreference = 'system' | 'light' | 'dark';
export type LanguagePreference = 'system' | 'en' | 'zh-Hant';

type StoredTerminalPreferences = Partial<TerminalPreferences> & {
  backgroundOpacity?: unknown;
};

export interface DevicePreferences {
  alertsEnabled: boolean;
  ttsEnabled: boolean;
  biometricForKeys: boolean;
  biometricOnResume: boolean;
  appearance: AppearancePreference;
  language: LanguagePreference;
  keepScreenOn: boolean;
  reopenTerminalOnLaunch: boolean;
  lastTab: AppTab;
  terminal: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
}

export const defaultDevicePreferences: DevicePreferences = {
  alertsEnabled: true,
  ttsEnabled: false,
  biometricForKeys: false,
  biometricOnResume: false,
  appearance: 'system',
  language: 'system',
  keepScreenOn: false,
  reopenTerminalOnLaunch: false,
  lastTab: 'hosts',
  terminal: {
    fontSize: 8,
    scrollback: 5000,
    cursorBlink: true,
    backgroundImageUri: null,
    backgroundDimming: 60,
  },
  terminalControlUsage: {},
};

export async function loadDevicePreferences(): Promise<DevicePreferences> {
  const current = await AsyncStorage.getItem(DEVICE_PREFERENCES_KEY);
  if (current) return migrateDevicePreferences(parseDevicePreferences(current));
  for (const key of LEGACY_DEVICE_PREFERENCES_KEYS) {
    const value = await AsyncStorage.getItem(key);
    if (value) return migrateDevicePreferences(parseDevicePreferences(value, true));
  }
  return defaultDevicePreferences;
}

async function migrateDevicePreferences(preferences: DevicePreferences): Promise<DevicePreferences> {
  const previousUri = preferences.terminal.backgroundImageUri;
  try {
    const backgroundImageUri = await migrateTerminalBackgroundImage(previousUri);
    if (backgroundImageUri === previousUri) return preferences;

    const migrated = {
      ...preferences,
      terminal: { ...preferences.terminal, backgroundImageUri },
    };
    await AsyncStorage.setItem(DEVICE_PREFERENCES_KEY, JSON.stringify(migrated));
    await removeTerminalBackgroundImage(previousUri);
    return migrated;
  } catch {
    // Keep using the previous setting and retry the migration next launch.
    return preferences;
  }
}

function parseDevicePreferences(value: string, migratingLegacy = false): DevicePreferences {
  try {
    const parsed = JSON.parse(value) as Partial<DevicePreferences>;
    const terminal = (parsed.terminal || {}) as StoredTerminalPreferences;
    const fontSize = migratingLegacy && terminal.fontSize === 11
      ? defaultDevicePreferences.terminal.fontSize
      : clampNumber(terminal.fontSize, 8, 24, defaultDevicePreferences.terminal.fontSize);
    return {
      alertsEnabled: parsed.alertsEnabled ?? defaultDevicePreferences.alertsEnabled,
      ttsEnabled: parsed.ttsEnabled ?? defaultDevicePreferences.ttsEnabled,
      biometricForKeys: parsed.biometricForKeys === true,
      biometricOnResume: parsed.biometricOnResume === true,
      appearance: isAppearancePreference(parsed.appearance)
        ? parsed.appearance
        : defaultDevicePreferences.appearance,
      language: isLanguagePreference(parsed.language)
        ? parsed.language
        : defaultDevicePreferences.language,
      keepScreenOn: parsed.keepScreenOn === true,
      reopenTerminalOnLaunch: parsed.reopenTerminalOnLaunch === true,
      lastTab: isAppTab(parsed.lastTab) ? parsed.lastTab : defaultDevicePreferences.lastTab,
      terminalControlUsage: parseTerminalControlUsage(parsed.terminalControlUsage),
      terminal: {
        fontSize,
        scrollback: clampNumber(terminal.scrollback, 1000, 20000, defaultDevicePreferences.terminal.scrollback),
        cursorBlink: terminal.cursorBlink ?? defaultDevicePreferences.terminal.cursorBlink,
        backgroundImageUri: typeof terminal.backgroundImageUri === 'string' && terminal.backgroundImageUri
          ? terminal.backgroundImageUri
          : null,
        backgroundDimming: clampNumber(
          terminal.backgroundDimming ?? terminal.backgroundOpacity,
          0,
          100,
          defaultDevicePreferences.terminal.backgroundDimming,
        ),
      },
    };
  } catch {
    return defaultDevicePreferences;
  }
}

export async function saveDevicePreferences(preferences: DevicePreferences): Promise<void> {
  await AsyncStorage.setItem(DEVICE_PREFERENCES_KEY, JSON.stringify(preferences));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

function isAppTab(value: unknown): value is AppTab {
  return value === 'hosts' || value === 'herd' || value === 'terminal' || value === 'more';
}

function isAppearancePreference(value: unknown): value is AppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || value === 'en' || value === 'zh-Hant';
}
