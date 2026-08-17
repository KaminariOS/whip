import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

const assets = resolve(__dirname, '../android/app/src/main/assets');
const sourceFonts = resolve(__dirname, '../assets/terminal-fonts');
const terminalRenderer = resolve(__dirname, '../src/components/TerminalRendererHost.tsx');
const iosTerminalSource = resolve(__dirname, '../src/generated/iosTerminalHtml.ts');

function readTerminalMarkup(html: string): string {
  const encoded = html.match(
    /const terminalMarkup = (.*);\n {4}const createTerminalSession/,
  )?.[1];
  if (!encoded) throw new Error('Generated terminal host does not embed terminal markup');
  return JSON.parse(encoded);
}

describe('Android terminal assets', () => {
  it('loads the packaged WezTerm font stack before xterm initialization', () => {
    const html = readFileSync(resolve(assets, 'herdr-terminal.html'), 'utf8');
    const markup = readTerminalMarkup(html);

    expect(html).not.toContain('data:font');
    expect(html).toContain("url('jetbrains-mono-regular.ttf') format('truetype')");
    expect(html).toContain("url('jetbrains-mono-bold.ttf') format('truetype')");
    expect(html).toContain("url('symbols-nerd-font-mono-regular.ttf') format('truetype')");
    expect(html).toContain("font-family: 'Herdr Terminal Mono'");
    expect(html).toContain("font-family: 'Herdr Terminal Symbols'");
    expect(html).toContain("font-family: 'Herdr Terminal CJK'");
    expect(html).toContain("url('arphic-ukai-hk.ttf') format('truetype')");
    expect(html).toContain(
      '"Herdr Terminal Mono", "Noto Color Emoji", "Herdr Terminal Symbols", "Herdr Terminal CJK", monospace',
    );
    expect(html).toContain(
      "document.fonts.load('400 8px \"Herdr Terminal Symbols\"', '\\uf120')",
    );
    expect(html).toContain(
      "document.fonts.load('400 8px \"Herdr Terminal CJK\"', '\\u4e2d')",
    );
    expect(html).toContain("fontWeightBold: '700'");
    expect(html).toContain('fontSize: 8');
    expect(html).toContain('Math.max(8, Math.min(24');
    expect(html).toContain('document.fonts.load');
    expect(html).toContain('terminal.attachCustomKeyEventHandler');
    expect(html).toContain("linkHandler: { activate: (_event, link) => send({ type: 'open-link', link }) }");
    expect(html).toContain('terminal.parser.registerOscHandler(8, data => {');
    expect(html).toContain('const marker = terminal.registerMarker();');
    expect(html).toContain('links: mergeTerminalLinks(terminalRows(), terminal.cols, osc8Links)');
    expect(html).toContain('return osc8LinkAt(osc8Links, cell.row, cell.col)');
    expect(html).toContain('installAndroidImeBridge(terminal, send, navigator.userAgent)');
    expect(html).toContain('terminalInputDelta(mirroredValue, next)');
    expect(html).toContain("inputType !== 'insertReplacementText'");
    expect(html).toContain("send({ type: 'input', data: sequence })");
    expect(html).toContain("send({ type: 'ready' })");
    expect(html).toContain('font-display: block');
    expect(html.indexOf('document.fonts?.load')).toBeLessThan(
      html.indexOf('const terminal = new Terminal'),
    );
    expect(html).toContain('Promise.race([');
    expect(html).toContain('pendingFrames.clear();');
    expect(html).toContain('background: transparent');
    expect(html).toContain('.xterm .scrollbar { display: none !important; }');
    expect(html).toContain('background-color: transparent !important');
    expect(html).toContain('overviewRuler: { width: 1 }');
    expect(html).toContain('allowTransparency: true');
    expect(html).toContain("background: 'rgba(0,0,0,0)'");
    expect(markup).toContain('<img id="terminal-background-image" alt="" />');
    expect(markup).toContain('<div id="terminal-background-glass"></div>');
    expect(html).toContain('mix-blend-mode: screen');
    expect(html).toContain('backgroundImage.src = backgroundUri');
    expect(html).toContain(
      "backgroundGlass.style.backgroundColor = 'rgba(0,0,0,' + dimming",
    );
    expect(html).toContain("foreground: '#c0caf5'");
    expect(html).toContain("cursor: '#c0caf5'");
    expect(html).toContain("selectionBackground: '#283457'");
    expect(html).toContain("blue: '#7aa2f7'");
    expect(html).toContain("magenta: '#bb9af7'");
    expect(html).toContain("cyan: '#7dcfff'");
    expect(html).not.toContain('#d8ff63');

    const inlineScript = html.match(
      /<script>\n([\s\S]*?)\n {2}<\/script>/,
    )?.[1];
    expect(inlineScript).toBeDefined();
    expect(() => new Script(inlineScript!)).not.toThrow();
  });

  it('keeps font bytes out of the WebView HTML', () => {
    const html = readFileSync(resolve(assets, 'herdr-terminal.html'), 'utf8');

    expect(Buffer.byteLength(html)).toBeLessThan(100_000);
    expect(html).not.toMatch(/base64,[A-Za-z0-9+/=]{100,}/);
  });

  it.each([
    'jetbrains-mono-regular.ttf',
    'jetbrains-mono-bold.ttf',
    'symbols-nerd-font-mono-regular.ttf',
  ])('%s is a real TrueType font', file => {
    const font = readFileSync(resolve(assets, file));

    expect(font.length).toBeGreaterThan(100_000);
    expect([...font.subarray(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  it('packages the standalone Arphic UKai HK TrueType face', () => {
    const font = readFileSync(resolve(assets, 'arphic-ukai-hk.ttf'));

    expect(font.length).toBeGreaterThan(10_000_000);
    expect([...font.subarray(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
    expect(
      font.equals(readFileSync(resolve(sourceFonts, 'ArphicUKaiHK.ttf'))),
    ).toBe(true);
  });

  it.each([
    ['JetBrainsMono-Regular.ttf', 'jetbrains-mono-regular.ttf'],
    ['JetBrainsMono-Bold.ttf', 'jetbrains-mono-bold.ttf'],
    ['SymbolsNerdFontMono-Regular.ttf', 'symbols-nerd-font-mono-regular.ttf'],
  ])('copies the vendored WezTerm face %s unchanged', (source, bundled) => {
    expect(
      readFileSync(resolve(assets, bundled)).equals(
        readFileSync(resolve(sourceFonts, source)),
      ),
    ).toBe(true);
  });

  it('packages the JetBrains Mono license with the Android font assets', () => {
    expect(readFileSync(resolve(assets, 'jetbrains-mono-OFL.txt'))).toEqual(
      readFileSync(resolve(sourceFonts, 'OFL.txt')),
    );
  });

  it('packages the Nerd Fonts license with the Android font assets', () => {
    expect(
      readFileSync(resolve(assets, 'symbols-nerd-font-LICENSE.txt')),
    ).toEqual(readFileSync(resolve(sourceFonts, 'NerdFonts-LICENSE.txt')));
  });

  it('packages the Arphic license with the Android font assets', () => {
    expect(readFileSync(resolve(assets, 'arphic-ukai-LICENSE.txt'))).toEqual(
      readFileSync(resolve(sourceFonts, 'ARPHICPL.txt')),
    );
  });

  it('keeps the packaged Android document and selects an inline iOS document', () => {
    const renderer = readFileSync(terminalRenderer, 'utf8');
    const iosSource = readFileSync(iosTerminalSource, 'utf8');

    expect(renderer).toContain("android: { uri: 'file:///android_asset/herdr-terminal.html' }");
    expect(renderer).toContain("ios: { html: IOS_TERMINAL_HTML, baseUrl: 'about:blank' }");
    expect(renderer).toContain('source={TERMINAL_SOURCE}');
    expect(renderer).toContain("import WebView from 'react-native-webview'");
    expect(renderer).not.toContain('WebView.android');
    expect(iosSource).toContain('IOS_TERMINAL_HTML_TEMPLATE');
    expect(iosSource).toContain('__HERDR_TEXT_REGULAR__');
    expect(iosSource).toContain('window.ReactNativeWebView.postMessage');
    expect(iosSource).not.toContain('file:///android_asset/');
    expect(iosSource).not.toMatch(/data:font[^;]*;base64/);
  });

  it('keeps Android text scaling from corrupting xterm character measurements', () => {
    const renderer = readFileSync(terminalRenderer, 'utf8');

    expect(renderer).toContain('textZoom={100}');
  });

  it('resets an activated terminal without automatically focusing its keyboard', () => {
    const html = readFileSync(resolve(assets, 'herdr-terminal.html'), 'utf8');
    const activateScript = html.match(
      /window\.herdrActivate = key => \{[\s\S]*?\n {4}\};/,
    )?.[0];
    const hostScript = html.match(
      /(const terminals = new Map\(\);[\s\S]*?)(?= {4}window\.herdrWriteBase64Chunk)/,
    )?.[1];
    const roots: Array<{
      classList: { toggle: jest.Mock };
      innerHTML: string;
      remove: jest.Mock;
      style: { transform?: string };
    }> = [];
    const terminalHost = { appendChild: jest.fn() };
    const context = {
      createTerminalSession: jest.fn(() => ({})),
      document: {
        createElement: jest.fn(() => {
          const root = {
            classList: { toggle: jest.fn() },
            innerHTML: '',
            remove: jest.fn(),
            style: {},
          };
          roots.push(root);
          return root;
        }),
        getElementById: jest.fn(() => terminalHost),
      },
      terminalMarkup: '',
      window: {
        innerWidth: 400,
        ReactNativeWebView: { postMessage: jest.fn() },
      } as {
        herdrActivate?: (key: string) => void;
        herdrSwipe?: (originKey: string, targetKey: string, direction: number, offset: number) => void;
        innerWidth: number;
        ReactNativeWebView: { postMessage: jest.Mock };
      },
    };

    expect(activateScript).toContain("call(key, 'herdrFit');");
    expect(activateScript).not.toContain('herdrFocus');
    expect(hostScript).toBeDefined();
    new Script(hostScript!).runInNewContext(context);
    context.window.herdrActivate!('origin');
    context.window.herdrSwipe!('origin', 'target', 1, -60);
    expect(roots[1].style.transform).toBe('translateX(340px)');

    context.window.herdrActivate!('target');
    expect(roots[1].style.transform).toBe('translateX(0)');
  });
});
