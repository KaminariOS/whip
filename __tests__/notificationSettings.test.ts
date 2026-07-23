import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mockOpenNotificationSettings = jest.fn();

jest.mock('react-native', () => ({
  NativeModules: {
    HerdrSystemSettings: {
      openNotificationSettings: (...args: unknown[]) => mockOpenNotificationSettings(...args),
    },
  },
  Platform: { OS: 'android' },
}));

import { openNotificationSettings } from '../src/services/notificationSettings';

beforeEach(() => {
  mockOpenNotificationSettings.mockReset();
});

it('opens this app notification settings through the Android native module', async () => {
  mockOpenNotificationSettings.mockResolvedValue(undefined);

  await openNotificationSettings();

  expect(mockOpenNotificationSettings).toHaveBeenCalledTimes(1);
});

it('targets the notification settings screen across supported Android versions', () => {
  const module = readFileSync(
    resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/HerdrSystemSettingsModule.kt'),
    'utf8',
  );
  const nativePackage = readFileSync(
    resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/HerdrBackgroundPackage.kt'),
    'utf8',
  );
  const settingsScreen = readFileSync(
    resolve(__dirname, '../src/components/SettingsScreen.tsx'),
    'utf8',
  );

  expect(module).toContain('Settings.ACTION_APP_NOTIFICATION_SETTINGS');
  expect(module).toContain('Settings.EXTRA_APP_PACKAGE');
  expect(module).toContain('ACTION_APP_NOTIFICATION_SETTINGS');
  expect(module).toContain('EXTRA_APP_UID');
  expect(module).toContain('Settings.ACTION_APPLICATION_DETAILS_SETTINGS');
  expect(nativePackage).toContain('HerdrSystemSettingsModule(reactContext)');
  expect(settingsScreen).toContain("t('settings.changeNotificationSettings')");
  expect(settingsScreen).toContain('onPress={changeNotificationSettings}');
});
