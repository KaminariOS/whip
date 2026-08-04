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
  expect(screen).not.toContain('onOpenSettings');
  expect(screen).not.toContain('onOpenAbout');
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
