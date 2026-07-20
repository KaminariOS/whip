import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('About screen', () => {
  it('shows the current installed Whip version', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('Application.nativeApplicationVersion');
    expect(screen).toContain('Version {whipVersion}');
  });
});
