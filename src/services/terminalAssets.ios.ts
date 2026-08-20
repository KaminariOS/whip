import { requireNativeModule } from 'expo-modules-core';

interface TerminalAssetLocation {
  directoryURL?: string;
  indexURL?: string;
  mermaidURL?: string;
}

export const IOS_TERMINAL_ASSETS = requireNativeModule<TerminalAssetLocation>(
  'TerminalAssets',
);
