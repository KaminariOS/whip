import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('shows settings and about content directly in More', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/MoreScreen.tsx'),
    'utf8',
  );

  expect(screen).toContain('<SettingsSection');
  expect(screen).toContain('<AboutSection');
  expect(screen).not.toContain('onOpenSettings');
  expect(screen).not.toContain('onOpenAbout');
});
