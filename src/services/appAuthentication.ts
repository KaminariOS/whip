import * as LocalAuthentication from 'expo-local-authentication';
import { NativeModules, Platform } from 'react-native';

interface AppAuthenticationNativeModule {
  authenticateAppAccess(): Promise<boolean>;
  authenticateGlobalKeychain(): Promise<boolean>;
}

function nativeModule(): AppAuthenticationNativeModule | null {
  if (Platform.OS !== 'android') return null;
  return NativeModules.HerdrCredentialVault as AppAuthenticationNativeModule | undefined || null;
}

type AuthenticationPurpose = 'app' | 'keychain';

async function authenticateIos(purpose: AuthenticationPurpose): Promise<void> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: purpose === 'app' ? 'Unlock Whip' : 'Unlock SSH keychain',
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
    fallbackLabel: 'Use Device Passcode',
  });
  if (result.success) return;

  const cancelled = ['app_cancel', 'system_cancel', 'user_cancel'].includes(result.error);
  const error = new Error(cancelled
    ? 'Authentication was cancelled'
    : `Device authentication was not successful (${result.error})`) as Error & { code: string };
  error.code = cancelled
    ? purpose === 'app' ? 'E_APP_AUTH_CANCELLED' : 'E_GLOBAL_KEYCHAIN_CANCELLED'
    : 'E_DEVICE_AUTH_FAILED';
  throw error;
}

export async function authenticateAppAccess(): Promise<void> {
  if (Platform.OS === 'ios') return authenticateIos('app');
  const module = nativeModule();
  if (!module) throw new Error('Biometric app protection requires a new Android app build');
  const authenticated = await module.authenticateAppAccess();
  if (!authenticated) throw new Error('Biometric authentication was not successful');
}

export async function authenticateGlobalKeychain(): Promise<void> {
  if (Platform.OS === 'ios') return authenticateIos('keychain');
  const module = nativeModule();
  if (!module) throw new Error('The global SSH keychain requires a new Android app build');
  const authenticated = await module.authenticateGlobalKeychain();
  if (!authenticated) throw new Error('Biometric authentication was not successful');
}
