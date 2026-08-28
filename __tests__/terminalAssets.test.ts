import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

const ANDROID_ASSET = 'android/app/src/main/assets/herdr-terminal.html';
const IOS_ASSET = 'modules/whip-terminal-assets/ios/TerminalAssets/index.html';

function artifact(path: string): string {
  return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    match => match[1],
  );
}

function platformNeutralAsset(html: string): string {
  return html
    .replace(/^\s*<base href="file:\/\/\/android_asset\/">\n/m, '')
    .replace(
      /^\s*const terminalFontFamily = .*;$/m,
      "    const terminalFontFamily = '<platform monospace>';",
    );
}

describe('generated terminal artifacts', () => {
  const android = artifact(ANDROID_ASSET);
  const ios = artifact(IOS_ASSET);

  test('Android and iOS ship the same generated terminal runtime', () => {
    expect(platformNeutralAsset(android)).toBe(platformNeutralAsset(ios));
  });

  test.each([
    ['Android', android],
    ['iOS', ios],
  ])(
    '%s artifact exposes the terminal DOM and runtime contracts',
    (_platform, html) => {
      expect(html).toMatch(/<div\s+id="terminals"[^>]*>/);
      expect(html).toContain('<script src="addon-serialize.js"></script>');
      expect(html).toContain('api.herdrSetVisualInsets = options =>');
      expect(html).toContain("type: 'cache-snapshot'");
      expect(html).toContain('--terminal-geometry-bottom');
      expect(html).toContain('--terminal-visual-offset');
      expect(html).toContain('function terminalBoundaryScroll(');
      expect(html).toContain('scrollTerminalPixels(deltaPx, point)');
      expect(html).not.toContain('terminalVisualBoundaryPreference');
      expect(html).not.toContain('transition: transform 120ms');
    },
  );

  test.each([
    ['Android', android],
    ['iOS', ios],
  ])('%s inline JavaScript compiles', (_platform, html) => {
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(() => new Script(script)).not.toThrow();
    }
  });
});
