import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectFile = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

test('Android backup includes the AsyncStorage database for legacy and modern restore', () => {
  const manifest = projectFile('android/app/src/main/AndroidManifest.xml');
  const backupRules = projectFile('android/app/src/main/res/xml/backup_rules.xml');
  const extractionRules = projectFile(
    'android/app/src/main/res/xml/data_extraction_rules.xml',
  );
  const packageJson = JSON.parse(projectFile('package.json')) as {
    dependencies?: Record<string, string>;
  };

  expect(packageJson.dependencies?.['@react-native-async-storage/async-storage'])
    .toBeDefined();
  expect(manifest).toContain('android:allowBackup="true"');
  expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
  expect(manifest).toContain(
    'android:dataExtractionRules="@xml/data_extraction_rules"',
  );
  expect(backupRules).toMatch(/<include\s+domain="database"\s+path="\."\s*\/>/);

  const cloudBackup = extractionRules.match(
    /<cloud-backup>([\s\S]*?)<\/cloud-backup>/,
  )?.[1];
  const deviceTransfer = extractionRules.match(
    /<device-transfer>([\s\S]*?)<\/device-transfer>/,
  )?.[1];
  expect(cloudBackup).toMatch(/<include\s+domain="database"\s+path="\."\s*\/>/);
  expect(deviceTransfer).toMatch(
    /<include\s+domain="database"\s+path="\."\s*\/>/,
  );
});
