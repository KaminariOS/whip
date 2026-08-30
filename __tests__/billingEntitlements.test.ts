import { hasCapability } from '../src/billing/capabilities';
import { effectiveDevicePreferences } from '../src/billing/effectiveSettings';
import { revenueCatPublicSdkKey } from '../src/billing/revenueCatConfiguration';
import { resolveWhipEntitlements } from '../src/billing/revenueCatEntitlements';
import {
  RANCHER_TRIAL_DURATION_MS,
  RANCHER_TRIAL_ELIGIBILITY_START_MS,
  resolveRancherTrial,
} from '../src/billing/rancherTrial';
import { resolveAccessTier } from '../src/billing/tiers';
import type { DevicePreferences } from '../src/services/devicePreferences';

describe('Whip billing entitlements', () => {
  test('resolves missing and inactive Rancher entitlements to Cowboy', () => {
    expect(resolveWhipEntitlements(null)).toEqual({
      tier: 'cowboy',
    });
    expect(resolveWhipEntitlements({
      entitlements: {
        active: {},
      },
    }).tier).toBe('cowboy');
  });

  test('resolves only the active whip_rancher entitlement as Rancher', () => {
    expect(resolveWhipEntitlements({
      entitlements: {
        active: {
          whip_rancher: {
            isActive: true,
          },
        },
      },
    })).toEqual({
      tier: 'rancher',
    });

    expect(resolveWhipEntitlements({
      entitlements: {
        active: {
          rancher: {
            isActive: true,
          },
        },
      },
    })).toEqual({ tier: 'cowboy' });
  });

  test.each([
    'custom-app-background',
    'custom-terminal-background',
    'glass',
  ] as const)('%s is cosmetic Rancher capability', capability => {
    expect(hasCapability('cowboy', capability)).toBe(false);
    expect(hasCapability('rancher', capability)).toBe(true);
  });

  test('grants new installations exactly five days of Rancher access', () => {
    const installedAtMs = RANCHER_TRIAL_ELIGIBILITY_START_MS + 1_000;
    const installedAt = new Date(installedAtMs);

    expect(resolveRancherTrial(installedAt, installedAt)).toEqual({
      isActive: true,
      startedAt: installedAt,
      endsAt: new Date(installedAtMs + RANCHER_TRIAL_DURATION_MS),
      daysRemaining: 5,
    });
    expect(resolveRancherTrial(
      installedAt,
      new Date(installedAtMs + RANCHER_TRIAL_DURATION_MS - 1),
    ).daysRemaining).toBe(1);
    expect(resolveRancherTrial(
      installedAt,
      new Date(installedAtMs + RANCHER_TRIAL_DURATION_MS),
    ).isActive).toBe(false);
  });

  test('does not enroll existing or future-dated installations', () => {
    const now = new Date(RANCHER_TRIAL_ELIGIBILITY_START_MS + 10_000);
    expect(resolveRancherTrial(
      new Date(RANCHER_TRIAL_ELIGIBILITY_START_MS - 1),
      now,
    ).isActive).toBe(false);
    expect(resolveRancherTrial(new Date(now.getTime() + 1), now).isActive)
      .toBe(false);
  });

  test('keeps full access until the developer payment toggle is enabled', () => {
    expect(resolveAccessTier('cowboy', false)).toBe('rancher');
    expect(resolveAccessTier('cowboy', true)).toBe('cowboy');
    expect(resolveAccessTier('rancher', true)).toBe('rancher');
  });

  test('derives effective cosmetics without mutating stored preferences', () => {
    const stored: DevicePreferences = {
      alertsEnabled: true,
      persistentAlertDurationSeconds: 30,
      ttsEnabled: false,
      biometricForKeys: false,
      biometricOnResume: false,
      appearance: 'system',
      fullscreenApp: false,
      appBackgroundImageUri: 'file:///app.jpg',
      appBackgroundDimming: 35,
      appGlassEnabled: true,
      developerOptionsEnabled: false,
      rancherPaymentsEnabled: false,
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
        scrollback: 5_000,
        xtermCacheCapacity: 8,
        cursorBlink: true,
        doubleTapAction: 'tab',
        openLinksInApp: true,
        pauseResizeInBackground: true,
        visualHints: false,
        backgroundImageUri: 'file:///terminal.jpg',
        backgroundDimming: 45,
      },
      terminalControlUsage: {},
    };
    const before = structuredClone(stored);

    const cowboy = effectiveDevicePreferences(stored, 'cowboy');
    expect(cowboy.appBackgroundImageUri).toBeNull();
    expect(cowboy.appGlassEnabled).toBe(false);
    expect(cowboy.terminal.backgroundImageUri).toBeNull();
    expect(stored).toEqual(before);

    const rancher = effectiveDevicePreferences(stored, 'rancher');
    expect(rancher).toBe(stored);
    expect(rancher.appBackgroundImageUri).toBe('file:///app.jpg');
    expect(rancher.appGlassEnabled).toBe(true);
    expect(rancher.terminal.backgroundImageUri).toBe('file:///terminal.jpg');
  });

  test('missing RevenueCat configuration safely has no SDK key', () => {
    expect(revenueCatPublicSdkKey({}, 'android', false)).toBeNull();
    expect(revenueCatPublicSdkKey(undefined, 'ios', false)).toBeNull();
    expect(revenueCatPublicSdkKey(
      { revenueCatTestPublicSdkKey: 'test_public' },
      'android',
      false,
    )).toBeNull();
  });
});
