import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('About screen', () => {
  it('shows the current installed Whip version', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('Application.nativeApplicationVersion');
    expect(screen).toContain("t('common.version', { version: whipVersion })");
  });

  it('shows the terminal font manifest', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain("terminalFonts.text.displayName");
    expect(screen).toContain("terminalFonts.cjk.displayName");
    expect(screen).toContain("terminalFonts.symbols.displayName");
    expect(screen).toContain("terminalFonts.emoji.displayName");
    expect(screen).toContain("terminalFonts.fallback.displayName");
  });
});
