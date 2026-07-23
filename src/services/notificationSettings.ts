import { NativeModules, Platform } from 'react-native';

interface HerdrSystemSettingsNativeModule {
  openNotificationSettings(): Promise<void>;
}

export async function openNotificationSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;

  const module = NativeModules.HerdrSystemSettings as HerdrSystemSettingsNativeModule | undefined;
  if (!module) {
    throw new Error('HerdrSystemSettings native module is not installed in this build');
  }

  await module.openNotificationSettings();
}
