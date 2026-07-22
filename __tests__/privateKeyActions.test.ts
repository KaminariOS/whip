import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const connectionScreen = readFileSync(
  resolve(__dirname, '../src/components/ConnectionScreen.tsx'),
  'utf8',
);
const filePicker = readFileSync(
  resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/PrivateKeyFilePickerModule.kt'),
  'utf8',
);
const nativePackage = readFileSync(
  resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/HerdrBackgroundPackage.kt'),
  'utf8',
);
const sshModule = readFileSync(
  resolve(__dirname, '../packages/react-native-ssh-sftp/android/src/main/java/me/dylankenneally/rnssh/RNSshClientModule.java'),
  'utf8',
);

test('uses key action sheets instead of exposing the private key in a text area', () => {
  expect(connectionScreen).toContain("t('connection.copyPrivate')");
  expect(connectionScreen).toContain("t('connection.copyPublic')");
  expect(connectionScreen).toContain("t('connection.pasteClipboard')");
  expect(connectionScreen).toContain("t('connection.selectFile')");
  expect(connectionScreen).toContain("t('connection.generateNew')");
  expect(connectionScreen).not.toContain("multiline={profile.authMode === 'key'}");
});

test('registers a bounded Android document picker for private key files', () => {
  expect(nativePackage).toContain('PrivateKeyFilePickerModule(reactContext)');
  expect(filePicker).toContain('Intent.ACTION_OPEN_DOCUMENT');
  expect(filePicker).toContain('MAX_KEY_BYTES = 1024 * 1024');
});

test('derives a public key from the loaded private key', () => {
  expect(sshModule).toContain('kpair.writePublicKey(publicKeyOut, "herdr")');
  expect(sshModule).toContain('result.putString("publicKey"');
});
