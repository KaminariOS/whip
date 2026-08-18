import { requireNativeModule } from 'expo-modules-core';

interface TerminalAssetLocation {
  directoryURL?: string;
  indexURL?: string;
}

export const IOS_TERMINAL_ASSETS = requireNativeModule<TerminalAssetLocation>(
  'TerminalAssets',
);
