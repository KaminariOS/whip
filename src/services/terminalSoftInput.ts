import { NativeModules, Platform } from 'react-native';

interface HerdrSoftInputNativeModule {
  setComposerOverlayEnabled(owner: string, enabled: boolean): Promise<void>;
}

export async function setTerminalComposerOverlay(
  owner: string,
  enabled: boolean,
): Promise<void> {
  if (Platform.OS !== 'android') return;

  const module = NativeModules.HerdrSoftInput as HerdrSoftInputNativeModule | undefined;
  if (!module) {
    throw new Error('HerdrSoftInput native module is not installed in this build');
  }

  await module.setComposerOverlayEnabled(owner, enabled);
}
