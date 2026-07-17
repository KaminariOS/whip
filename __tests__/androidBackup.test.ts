import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Android host backup', () => {
  const manifest = readFileSync(
    resolve(__dirname, '../android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  const legacyRules = readFileSync(
    resolve(__dirname, '../android/app/src/main/res/xml/backup_rules.xml'),
    'utf8',
  );
  const extractionRules = readFileSync(
    resolve(__dirname, '../android/app/src/main/res/xml/data_extraction_rules.xml'),
    'utf8',
  );
  const appConfig = JSON.parse(
    readFileSync(resolve(__dirname, '../app.json'), 'utf8'),
  );

  it('enables restore in both Expo config and the native manifest', () => {
    expect(appConfig.expo.android.allowBackup).toBe(true);
    expect(manifest).toContain('android:allowBackup="true"');
    expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
  });

  it('backs up AsyncStorage databases without backing up Keystore-encrypted credentials', () => {
    expect(legacyRules).toContain('<include domain="database" path="." />');
    expect(extractionRules.match(/<include domain="database" path="\." \/>/g)).toHaveLength(2);

    for (const rules of [legacyRules, extractionRules]) {
      expect(rules).not.toContain('domain="file"');
      expect(rules).not.toContain('domain="sharedpref"');
      expect(rules).not.toContain('domain="root"');
    }
  });
});
