import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('shows settings and about content directly in More', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/MoreScreen.tsx'),
    'utf8',
  );

  expect(screen).toContain('<SettingsSection');
  expect(screen).toContain('<AboutSection');
  expect(screen.indexOf('<AboutSection')).toBeLessThan(screen.indexOf('<SettingsSection'));
  expect(screen.indexOf('<SettingsSection')).toBeLessThan(screen.indexOf('<AppLogsSection'));
  expect(screen).not.toContain('onOpenSettings');
  expect(screen).not.toContain('onOpenAbout');
  expect(screen).not.toContain('connectedHost');
  expect(screen).not.toContain("t('more.connectedTo'");
  expect(screen).not.toContain("t('more.noConnection'");
});

test('does not show the Private SSH boundary card', () => {
  const settings = readFileSync(
    resolve(__dirname, '../src/components/SettingsScreen.tsx'),
    'utf8',
  );

  expect(settings).not.toContain("t('settings.privateBoundary')");
  expect(settings).not.toContain("t('settings.privateBoundaryCopy')");
});

test('does not show a Disconnect SSH button', () => {
  const settings = readFileSync(
    resolve(__dirname, '../src/components/SettingsScreen.tsx'),
    'utf8',
  );

  expect(settings).not.toContain('onDisconnect');
  expect(settings).not.toContain("t('settings.disconnect')");
});

test('offers QR host pairing as an opt-in setting', () => {
  const settings = readFileSync(
    resolve(__dirname, '../src/components/SettingsScreen.tsx'),
    'utf8',
  );
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

  expect(settings).toContain("title={t('settings.sshQrPairing')}");
  expect(settings).toContain('value={props.sshQrPairingEnabled}');
  expect(settings).toContain("export const WHIP_PAIR_REPOSITORY_URL = 'https://github.com/KaminariOS/whip/blob/main/whip-pair/README.md';");
  expect(settings).toContain('Linking.openURL(WHIP_PAIR_REPOSITORY_URL)');
  expect(settings).toContain('onDetailsPress={openWhipPairRepository}');
  expect(app).toContain('if (sshQrPairingEnabled) setNewHostOpen(true);');
  expect(app).toContain('else setEditorProfile(emptyConnectionProfile());');
});

test('offers the genuine persistent agent alert as a notification test', () => {
  const settings = readFileSync(
    resolve(__dirname, '../src/components/SettingsScreen.tsx'),
    'utf8',
  );
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

  expect(settings).toContain("t('settings.testPersistentAlert')");
  expect(settings).toContain('onPress={props.onTestPersistentAlert}');
  expect(app).toContain("}, t('settings.testPersistentAlertTab'), 'persistent',");
  expect(app).toContain('persistentAlertDurationSecondsRef.current * 1_000');
});

test('uses a scalable language selection sheet instead of inline language pills', () => {
  const settings = readFileSync(
    resolve(__dirname, '../src/components/SettingsScreen.tsx'),
    'utf8',
  );

  expect(settings).toContain('function LanguageSelectionSheet');
  expect(settings).toContain("{ labelKey: 'settings.japanese', value: 'ja' }");
  expect(settings).toContain("{ labelKey: 'settings.spanish', value: 'es' }");
  expect(settings).toContain("{ labelKey: 'settings.simplifiedChinese', value: 'zh-Hans' }");
  expect(settings).toContain('accessibilityRole="radio"');
  expect(settings).toContain("selected && 'bg-primary/10'");
});

test('shows settings explanations in dismissible floating details', () => {
  const settings = readFileSync(
    resolve(__dirname, '../src/components/SettingsScreen.tsx'),
    'utf8',
  );

  expect(settings).toContain('function DetailsTitle');
  expect(settings).toContain('function SettingsDetailsProvider');
  expect(settings).toContain('onTouchStart={() => setActiveDetails(null)}');
  expect(settings).toContain('pointerEvents="none"');
  expect(settings).toContain('bg-foreground/70');
  expect(settings).toContain('activeDetails.containerHeight - activeDetails.anchorY + 8');
  const detailsTitle = settings.slice(
    settings.indexOf('function DetailsTitle'),
    settings.indexOf('function SettingRow'),
  );
  expect(detailsTitle).not.toContain('onLongPress');
  expect(settings).not.toMatch(/<Text[^>]*>\{t\('settings\.[^']+Copy'/);
});
