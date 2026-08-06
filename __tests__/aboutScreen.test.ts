import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('About screen', () => {
  it('is collapsed by default and can be expanded', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('const [expanded, setExpanded] = useState(false);');
    expect(screen).toContain('accessibilityState={{ expanded }}');
    expect(screen).toContain('setExpanded(value => !value)');
    expect(screen).toContain('{expanded ? (');
    expect(screen).toContain("t('about.copy')");
    expect(screen).toContain('className="min-h-[72px] w-full justify-start rounded-lg border border-border bg-card');
    expect(screen).toContain('variant="ghost"');
    expect(screen.indexOf("t('about.source')")).toBeLessThan(screen.indexOf('<WhipMark'));
  });

  it('shows the current installed Whip version', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('Application.nativeApplicationVersion');
    expect(screen).toContain("t('common.version', { version: whipVersion })");
  });

  it('shows the embedded build commit when available', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );
    const appConfig = readFileSync(
      resolve(__dirname, '../app.config.js'),
      'utf8',
    );

    expect(appConfig).toContain("execFileSync('git', ['rev-parse', 'HEAD']");
    expect(appConfig).toContain('process.env.GITHUB_SHA');
    expect(appConfig).toContain('gitCommit');
    expect(screen).toContain('Constants.expoConfig?.extra?.gitCommit');
    expect(screen).toContain('embeddedCommit.slice(0, 12)');
    expect(screen).toContain("t('about.commit', { hash: whipCommit })");
    expect(screen).toContain('`${WHIP_REPOSITORY_URL}/commit/${embeddedCommit}`');
    expect(screen).toContain("accessibilityLabel={t('about.openCommit', { hash: whipCommit })}");
    expect(screen).toContain('accessibilityRole="link"');
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

  it('opens and shares the GitHub releases page', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain("export const WHIP_RELEASES_URL = 'https://github.com/KaminariOS/whip/releases';");
    expect(screen).toContain('Linking.openURL(WHIP_RELEASES_URL)');
    expect(screen).toContain('Share.share({');
    expect(screen).toContain("accessibilityLabel={t('about.shareReleases')}");
    expect(screen).toContain('className="w-14 self-stretch');
    expect(screen).toContain('size="content"');
  });

  it('links to the Herdr website with the Herdr icon', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain("export const HERDR_WEBSITE_URL = 'https://herdr.dev/';");
    expect(screen).toContain('Linking.openURL(HERDR_WEBSITE_URL)');
    expect(screen).toContain('<HerdrMark size={44}');
    expect(screen).toContain('>herdr.dev</Text>');
    expect(screen).toContain("t('about.shareHerdrMessage', { url: HERDR_WEBSITE_URL })");
    expect(screen).toContain("accessibilityLabel={t('about.shareHerdrWebsite')}");
  });
});
