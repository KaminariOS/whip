import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

const assets = resolve(__dirname, '../android/app/src/main/assets');
const sourceFonts = resolve(__dirname, '../assets/terminal-fonts');
const generated = resolve(__dirname, '../src/generated/terminalHtml.ts');

describe('Android terminal assets', () => {
  it('bundles the WezTerm JetBrains Mono faces without blocking terminal readiness on font loading', () => {
    const html = readFileSync(resolve(assets, 'herdr-terminal.html'), 'utf8');

    expect(html).toContain("url('jetbrains-mono-regular.ttf')");
    expect(html).toContain("url('jetbrains-mono-bold.ttf')");
    expect(html).toContain("fontWeightBold: '700'");
    expect(html).toContain('fontSize: 8');
    expect(html).toContain('Math.max(8, Math.min(16');
    expect(html).toContain('document.fonts.load');
    expect(html).toContain("send({ type: 'ready' })");
    expect(html).toContain('font-display: swap');
    expect(html.indexOf('announceReady();')).toBeLessThan(html.indexOf('document.fonts?.load'));
    expect(html).toContain('pendingFrames.clear();');

    const inlineScript = html.match(/<script>\n([\s\S]*?)\n {2}<\/script>/)?.[1];
    expect(inlineScript).toBeDefined();
    expect(() => new Script(inlineScript!)).not.toThrow();
  });

  it.each(['jetbrains-mono-regular.ttf', 'jetbrains-mono-bold.ttf'])('%s is a real TrueType font', file => {
    const font = readFileSync(resolve(assets, file));

    expect(font.length).toBeGreaterThan(100_000);
    expect([...font.subarray(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  it.each([
    ['JetBrainsMono-Regular.ttf', 'jetbrains-mono-regular.ttf'],
    ['JetBrainsMono-Bold.ttf', 'jetbrains-mono-bold.ttf'],
  ])('copies the vendored WezTerm face %s unchanged', (source, bundled) => {
    expect(readFileSync(resolve(assets, bundled))).toEqual(readFileSync(resolve(sourceFonts, source)));
  });

  it('packages the JetBrains Mono license with the Android font assets', () => {
    expect(readFileSync(resolve(assets, 'jetbrains-mono-OFL.txt'))).toEqual(
      readFileSync(resolve(sourceFonts, 'OFL.txt')),
    );
  });

  it('generates the same HTML for Metro so terminal changes do not require an APK rebuild', () => {
    const html = readFileSync(resolve(assets, 'herdr-terminal.html'), 'utf8');
    const module = readFileSync(generated, 'utf8');
    const encoded = module.match(/export const terminalHtml = (.*);\n$/)?.[1];

    expect(encoded).toBeDefined();
    expect(JSON.parse(encoded!)).toBe(html);
  });
});
