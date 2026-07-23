import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const nativeSource = readFileSync(
  resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/CredentialVaultModule.kt'),
  'utf8',
);
const nativePackage = readFileSync(
  resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/HerdrBackgroundPackage.kt'),
  'utf8',
);
const gradle = readFileSync(resolve(__dirname, '../android/app/build.gradle'), 'utf8');

test('registers the credential vault and its stable Android dependencies', () => {
  expect(nativePackage).toContain('CredentialVaultModule(reactContext)');
  expect(gradle).toContain('androidx.biometric:biometric:1.1.0');
  expect(gradle).toContain('com.google.android.gms:play-services-auth-blockstore:16.4.0');
});

test('encrypts credential backups with AES-GCM and binds them to the host id', () => {
  expect(nativeSource).toContain('AES/GCM/NoPadding');
  expect(nativeSource).toContain('RECOVERY_KEY_BYTES = 32');
  expect(nativeSource).toContain('cipher.updateAAD(aad(credentialId))');
  expect(nativeSource).toContain('AndroidKeyStore');
  expect(nativeSource).toContain('wrapped_recovery_key_v1');
});

test('requires system authentication before retrieving the Block Store key', () => {
  expect(nativeSource).toContain('BiometricPrompt(');
  expect(nativeSource).toContain('BIOMETRIC_STRONG or DEVICE_CREDENTIAL');
  expect(nativeSource).toContain('BiometricPrompt.CryptoObject(createAuthenticationCipher())');
  expect(nativeSource).toContain('completeAuthenticationOperation(result)');
  expect(nativeSource).toContain('result.cryptoObject?.cipher');
  expect(nativeSource).toContain('cipher.doFinal(AUTHENTICATION_CHALLENGE)');
  expect(nativeSource.indexOf('onAuthenticationSucceeded')).toBeLessThan(
    nativeSource.indexOf('private fun retrieveRecoveryKey'),
  );
  expect(nativeSource).toContain('.setShouldBackupToCloud(cloudEnabled)');
  expect(nativeSource).toContain('isEndToEndEncryptionAvailable()');
});

test('exposes strong biometric-only authentication for unlocking the app', () => {
  expect(nativeSource).toContain('fun authenticateAppAccess(promise: Promise)');
  expect(nativeSource).toContain('private fun buildAppPromptInfo()');
  expect(nativeSource).toContain('.setAllowedAuthenticators(BIOMETRIC_STRONG)');
  expect(nativeSource).toContain('finishAppAuthenticationSuccess()');
});

test('uses a dedicated strong-biometric prompt for the global SSH keychain', () => {
  expect(nativeSource).toContain('fun authenticateGlobalKeychain(promise: Promise)');
  expect(nativeSource).toContain('private fun buildGlobalKeychainPromptInfo()');
  expect(nativeSource).toContain('R.string.global_keychain_unlock_title');
  expect(nativeSource).toContain('.setAllowedAuthenticators(BIOMETRIC_STRONG)');
});
