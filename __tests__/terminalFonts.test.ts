import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal font fallbacks', () => {
  it('generates a native fallback for each mobile platform', () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(__dirname, '../assets/terminal-fonts/manifest.json'),
        'utf8',
      ),
    );
    const generator = readFileSync(
      resolve(__dirname, '../scripts/sync-terminal-assets.mjs'),
      'utf8',
    );

    expect(manifest.fallback.android).toEqual({
      displayName: 'Android monospace',
      cssFamily: 'monospace',
    });
    expect(manifest.fallback.ios).toEqual({
      displayName: 'iOS system monospace',
      cssFamily: 'ui-monospace',
    });
    expect(generator).toContain(
      'terminalFontFamily(fontManifest.fallback.android)',
    );
    expect(generator).toContain(
      'terminalFontFamily(fontManifest.fallback.ios)',
    );
    expect(generator).toContain(
      "`const terminalFontFamily = '${iosTerminalFontFamily}';`",
    );
  });
});
