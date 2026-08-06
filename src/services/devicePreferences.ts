import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  parseTerminalDoubleTapAction,
  type TerminalDoubleTapAction,
} from '../lib/terminalDoubleTap';
import { parseTerminalControlUsage, type TerminalControlUsage } from '../lib/terminalControls';
import {
  parseTerminalVolumeKeyAction,
  type TerminalVolumeKeyAction,
} from '../lib/volumeKeys';
import {
  DEFAULT_XTERM_CACHE_CAPACITY,
  MIN_XTERM_CACHE_CAPACITY,
} from '../lib/terminalRendererLru';
import type { AppTab } from '../types';
import {
  migrateAppBackgroundImage,
  removeAppBackgroundImage,
} from './appBackground';
import {
  migrateTerminalBackgroundImage,
  removeTerminalBackgroundImage,
} from './terminalBackground';

const DEVICE_PREFERENCES_KEY = 'herdr.device.preferences.v3';
const LEGACY_DEVICE_PREFERENCES_KEYS = [
  'herdr.device.preferences.v2',
  'herdr.device.preferences.v1',
];

export const MIN_PERSISTENT_ALERT_DURATION_SECONDS = 5;
export const MAX_PERSISTENT_ALERT_DURATION_SECONDS = 60;
export const PERSISTENT_ALERT_DURATION_STEP_SECONDS = 5;

export interface TerminalPreferences {
  fullscreen: boolean;
  useModifierKeyIcons: boolean;
  volumeUpAction: TerminalVolumeKeyAction;
  volumeDownAction: TerminalVolumeKeyAction;
  fontSize: number;
  scrollback: number;
  xtermCacheCapacity: number;
  cursorBlink: boolean;
  doubleTapAction: TerminalDoubleTapAction;
  openLinksInApp: boolean;
  pauseResizeInBackground: boolean;
  backgroundImageUri: string | null;
  backgroundDimming: number;
}

export type AppearancePreference = 'system' | 'light' | 'dark';
export type LanguagePreference = 'system' | 'en' | 'zh-Hant';

type StoredTerminalPreferences = Partial<TerminalPreferences> & {
  backgroundOpacity?: unknown;
  doubleTapTab?: unknown;
};

export interface DevicePreferences {
  alertsEnabled: boolean;
  persistentAlertDurationSeconds: number;
  ttsEnabled: boolean;
  biometricForKeys: boolean;
  biometricOnResume: boolean;
  appearance: AppearancePreference;
  fullscreenApp: boolean;
  appBackgroundImageUri: string | null;
  appBackgroundDimming: number;
  appGlassEnabled: boolean;
  language: LanguagePreference;
  keepScreenOn: boolean;
  reopenTerminalOnLaunch: boolean;
  agentCommand: string;
  lastTab: AppTab;
  terminal: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
}

export const defaultDevicePreferences: DevicePreferences = {
  alertsEnabled: true,
  persistentAlertDurationSeconds: 30,
  ttsEnabled: false,
  biometricForKeys: false,
  biometricOnResume: false,
  appearance: 'system',
  fullscreenApp: false,
  appBackgroundImageUri: null,
  appBackgroundDimming: 60,
  appGlassEnabled: false,
  language: 'system',
  keepScreenOn: false,
  reopenTerminalOnLaunch: false,
  agentCommand: 'opencode',
  lastTab: 'hosts',
  terminal: {
    fullscreen: true,
    useModifierKeyIcons: false,
    volumeUpAction: 'none',
    volumeDownAction: 'none',
    fontSize: 8,
    scrollback: 5000,
    xtermCacheCapacity: DEFAULT_XTERM_CACHE_CAPACITY,
    cursorBlink: true,
    doubleTapAction: 'tab',
    openLinksInApp: true,
    pauseResizeInBackground: true,
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
  const previousTerminalUri = preferences.terminal.backgroundImageUri;
  const previousAppUri = preferences.appBackgroundImageUri;
  try {
    const [terminalBackgroundImageUri, appBackgroundImageUri] = await Promise.all([
      migrateTerminalBackgroundImage(previousTerminalUri),
      migrateAppBackgroundImage(previousAppUri),
    ]);
    if (
      terminalBackgroundImageUri === previousTerminalUri
      && appBackgroundImageUri === previousAppUri
    ) return preferences;

    const migrated = {
      ...preferences,
      appBackgroundImageUri,
      terminal: { ...preferences.terminal, backgroundImageUri: terminalBackgroundImageUri },
    };
    await AsyncStorage.setItem(DEVICE_PREFERENCES_KEY, JSON.stringify(migrated));
    if (terminalBackgroundImageUri !== previousTerminalUri) {
      await removeTerminalBackgroundImage(previousTerminalUri);
    }
    if (appBackgroundImageUri !== previousAppUri) {
      await removeAppBackgroundImage(previousAppUri);
    }
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
      persistentAlertDurationSeconds: clampNumber(
        parsed.persistentAlertDurationSeconds,
        MIN_PERSISTENT_ALERT_DURATION_SECONDS,
        MAX_PERSISTENT_ALERT_DURATION_SECONDS,
        defaultDevicePreferences.persistentAlertDurationSeconds,
      ),
      ttsEnabled: parsed.ttsEnabled ?? defaultDevicePreferences.ttsEnabled,
      biometricForKeys: parsed.biometricForKeys === true,
      biometricOnResume: parsed.biometricOnResume === true,
      appearance: isAppearancePreference(parsed.appearance)
        ? parsed.appearance
        : defaultDevicePreferences.appearance,
      fullscreenApp: parsed.fullscreenApp === true,
      appBackgroundImageUri: typeof parsed.appBackgroundImageUri === 'string' && parsed.appBackgroundImageUri
        ? parsed.appBackgroundImageUri
        : null,
      appBackgroundDimming: clampNumber(
        parsed.appBackgroundDimming,
        0,
        100,
        defaultDevicePreferences.appBackgroundDimming,
      ),
      appGlassEnabled: parsed.appGlassEnabled === true,
      language: isLanguagePreference(parsed.language)
        ? parsed.language
        : defaultDevicePreferences.language,
      keepScreenOn: parsed.keepScreenOn === true,
      reopenTerminalOnLaunch: parsed.reopenTerminalOnLaunch === true,
      agentCommand: typeof parsed.agentCommand === 'string' && parsed.agentCommand.trim()
        ? parsed.agentCommand
        : defaultDevicePreferences.agentCommand,
      lastTab: isAppTab(parsed.lastTab) ? parsed.lastTab : defaultDevicePreferences.lastTab,
      terminalControlUsage: parseTerminalControlUsage(parsed.terminalControlUsage),
      terminal: {
        fullscreen: typeof terminal.fullscreen === 'boolean'
          ? terminal.fullscreen
          : defaultDevicePreferences.terminal.fullscreen,
        useModifierKeyIcons: terminal.useModifierKeyIcons === true,
        volumeUpAction: parseTerminalVolumeKeyAction(
          terminal.volumeUpAction,
          defaultDevicePreferences.terminal.volumeUpAction,
        ),
        volumeDownAction: parseTerminalVolumeKeyAction(
          terminal.volumeDownAction,
          defaultDevicePreferences.terminal.volumeDownAction,
        ),
        fontSize,
        scrollback: clampNumber(terminal.scrollback, 1000, 20000, defaultDevicePreferences.terminal.scrollback),
        xtermCacheCapacity: parseXtermCacheCapacity(terminal.xtermCacheCapacity),
        cursorBlink: terminal.cursorBlink ?? defaultDevicePreferences.terminal.cursorBlink,
        doubleTapAction: parseTerminalDoubleTapAction(
          terminal.doubleTapAction,
          typeof terminal.doubleTapTab === 'boolean'
            ? terminal.doubleTapTab ? 'tab' : 'none'
            : defaultDevicePreferences.terminal.doubleTapAction,
        ),
        openLinksInApp: typeof terminal.openLinksInApp === 'boolean'
          ? terminal.openLinksInApp
          : defaultDevicePreferences.terminal.openLinksInApp,
        pauseResizeInBackground: typeof terminal.pauseResizeInBackground === 'boolean'
          ? terminal.pauseResizeInBackground
          : defaultDevicePreferences.terminal.pauseResizeInBackground,
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

function parseXtermCacheCapacity(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_XTERM_CACHE_CAPACITY
    ? value
    : DEFAULT_XTERM_CACHE_CAPACITY;
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
