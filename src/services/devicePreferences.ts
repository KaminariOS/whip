import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AppTab } from '../types';

const DEVICE_PREFERENCES_KEY = 'herdr.device.preferences.v3';
const LEGACY_DEVICE_PREFERENCES_KEYS = [
  'herdr.device.preferences.v2',
  'herdr.device.preferences.v1',
];

export interface TerminalPreferences {
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
}

export interface DevicePreferences {
  alertsEnabled: boolean;
  ttsEnabled: boolean;
  lastTab: AppTab;
  terminal: TerminalPreferences;
}

export const defaultDevicePreferences: DevicePreferences = {
  alertsEnabled: true,
  ttsEnabled: false,
  lastTab: 'hosts',
  terminal: {
    fontSize: 8,
    scrollback: 5000,
    cursorBlink: true,
  },
};

export async function loadDevicePreferences(): Promise<DevicePreferences> {
  const current = await AsyncStorage.getItem(DEVICE_PREFERENCES_KEY);
  if (current) return parseDevicePreferences(current);
  for (const key of LEGACY_DEVICE_PREFERENCES_KEYS) {
    const value = await AsyncStorage.getItem(key);
    if (value) return parseDevicePreferences(value, true);
  }
  return defaultDevicePreferences;
}

function parseDevicePreferences(value: string, migratingLegacy = false): DevicePreferences {
  try {
    const parsed = JSON.parse(value) as Partial<DevicePreferences>;
    const terminal = parsed.terminal || {} as Partial<TerminalPreferences>;
    const fontSize = migratingLegacy && terminal.fontSize === 11
      ? defaultDevicePreferences.terminal.fontSize
      : clampNumber(terminal.fontSize, 8, 16, defaultDevicePreferences.terminal.fontSize);
    return {
      alertsEnabled: parsed.alertsEnabled ?? defaultDevicePreferences.alertsEnabled,
      ttsEnabled: parsed.ttsEnabled ?? defaultDevicePreferences.ttsEnabled,
      lastTab: isAppTab(parsed.lastTab) ? parsed.lastTab : defaultDevicePreferences.lastTab,
      terminal: {
        fontSize,
        scrollback: clampNumber(terminal.scrollback, 1000, 20000, defaultDevicePreferences.terminal.scrollback),
        cursorBlink: terminal.cursorBlink ?? defaultDevicePreferences.terminal.cursorBlink,
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
