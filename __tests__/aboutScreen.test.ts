import { existsSync, readFileSync } from 'node:fs';
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
    expect(screen).toContain('const [contentMounted, setContentMounted] = useState(false);');
    expect(screen).toContain('const [contentMeasured, setContentMeasured] = useState(false);');
    expect(screen).toContain('if (!expanded) setContentMounted(true);');
    expect(screen).toContain('{contentMounted ? (');
    expect(screen).toContain('if (expanded && !contentMeasured)');
    expect(screen).toContain('progress.value = withTiming(expanded ? 1 : 0');
    expect(screen).toContain('height: contentHeight.value * progress.value');
    expect(screen).toContain('opacity: progress.value');
    expect(screen).toContain('className="absolute inset-x-0 top-0 pb-6 pt-7"');
    expect(screen).toContain("pointerEvents={expanded ? 'auto' : 'none'}");
    expect(screen).toContain("t('about.copy')");
    expect(screen).toContain('className="min-h-[72px] w-full justify-start overflow-hidden rounded-lg border border-white/30 bg-transparent');
    expect(screen).toContain('<GlassBackdrop />');
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
    expect(screen).toContain('ios: terminalFonts.fallback.ios');
    expect(screen).toContain('default: terminalFonts.fallback.android');
    expect(screen).toContain('value={fallbackFont.displayName}');
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
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );

    expect(screen).toContain("export const HERDR_WEBSITE_URL = 'https://herdr.dev/';");
    expect(screen).toContain('Linking.openURL(HERDR_WEBSITE_URL)');
    expect(screen).toContain('<HerdrMark size={44}');
    expect(appUi).toContain("import Svg, { Circle, G, Path, Rect } from 'react-native-svg';");
    expect(appUi).not.toContain('herdr-icon.png');
    expect(existsSync(resolve(__dirname, '../assets/herdr-icon.png'))).toBe(false);
    expect(screen).toContain('>herdr.dev</Text>');
    expect(screen).toContain("t('about.shareHerdrMessage', { url: HERDR_WEBSITE_URL })");
    expect(screen).toContain("accessibilityLabel={t('about.shareHerdrWebsite')}");
  });

  it('renders the Whip artwork from the committed SVG asset', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AboutScreen.tsx'),
      'utf8',
    );
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );

    expect(screen).toContain('<WhipMark size={82}');
    expect(appUi).toContain("import { LocalSvg } from 'react-native-svg/css';");
    expect(appUi).toContain("asset={require('../../assets/whip-cyborg-hand-concept.svg')}");
  });

  it('keeps the Whip artwork inside a safe area without a circular image mask', () => {
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );
    const whipMark = appUi.slice(
      appUi.indexOf('export function WhipMark'),
      appUi.indexOf('export function HerdrMark'),
    );
    const svg = readFileSync(
      resolve(__dirname, '../assets/whip-cyborg-hand-concept.svg'),
      'utf8',
    );

    expect(whipMark).toContain("asset={require('../../assets/whip-cyborg-hand-concept.svg')}");
    expect(whipMark).not.toContain('borderRadius');
    expect(svg).toContain('viewBox="-80 -80 1414 1414"');
    expect(svg).toContain('Preserve the tapered whip silhouette');
  });
});
