import { NativeModules, Platform } from 'react-native';

import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

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
    const error = new Error('HerdrSoftInput native module is not installed in this build');
    recordTerminalSoftInputFailure(enabled, error);
    throw error;
  }

  try {
    await module.setComposerOverlayEnabled(owner, enabled);
  } catch (error) {
    recordTerminalSoftInputFailure(enabled, error);
    throw error;
  }
}

function recordTerminalSoftInputFailure(enabled: boolean, error: unknown): void {
  recordOperationalDiagnostic('warn', 'Application', 'terminal-composer-overlay-update-failed', {
    enabled,
    ...operationalErrorDetails(error),
  });
}
