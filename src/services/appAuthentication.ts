import { NativeModules, Platform } from 'react-native';

interface AppAuthenticationNativeModule {
  authenticateAppAccess(): Promise<boolean>;
}

function nativeModule(): AppAuthenticationNativeModule | null {
  if (Platform.OS !== 'android') return null;
  return NativeModules.HerdrCredentialVault as AppAuthenticationNativeModule | undefined || null;
}

export async function authenticateAppAccess(): Promise<void> {
  const module = nativeModule();
  if (!module) throw new Error('Biometric app protection requires a new Android app build');
  const authenticated = await module.authenticateAppAccess();
  if (!authenticated) throw new Error('Biometric authentication was not successful');
}
