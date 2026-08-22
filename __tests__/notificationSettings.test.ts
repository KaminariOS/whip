const mockOpenNotificationSettings = jest.fn();

jest.mock('react-native', () => ({
  NativeModules: {
    HerdrSystemSettings: {
      openNotificationSettings: (...args: unknown[]) =>
        mockOpenNotificationSettings(...args),
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
