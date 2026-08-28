import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

import type { TerminalVolumeKey, TerminalVolumeKeyAction } from '../lib/volumeKeys';

const VOLUME_KEY_EVENT = 'herdrVolumeKey';

interface HerdrVolumeKeysNativeModule {
  configure: (enabled: boolean, interceptVolumeUp: boolean, interceptVolumeDown: boolean) => void;
}

const nativeModule = Platform.OS === 'android'
  ? NativeModules.HerdrVolumeKeys as HerdrVolumeKeysNativeModule | undefined
  : undefined;

export function configureTerminalVolumeKeys(
  enabled: boolean,
  volumeUpAction: TerminalVolumeKeyAction,
  volumeDownAction: TerminalVolumeKeyAction,
): void {
  nativeModule?.configure(
    enabled,
    volumeUpAction !== 'none',
    volumeDownAction !== 'none',
  );
}

export function addTerminalVolumeKeyListener(
  listener: (key: TerminalVolumeKey) => void,
): { remove: () => void } {
  if (Platform.OS !== 'android') return { remove: () => undefined };
  return DeviceEventEmitter.addListener(VOLUME_KEY_EVENT, (value: unknown) => {
    if (value === 'up' || value === 'down') listener(value);
  });
}
