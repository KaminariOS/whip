import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

const assets = resolve(__dirname, '../android/app/src/main/assets');
const iosModule = resolve(__dirname, '../modules/whip-terminal-assets');
const iosAssets = resolve(iosModule, 'ios/TerminalAssets');
const iosProject = resolve(__dirname, '../ios/HerdR.xcodeproj/project.pbxproj');
const sourceFonts = resolve(__dirname, '../assets/terminal-fonts');
const terminalRenderer = resolve(__dirname, '../src/components/TerminalRendererHost.tsx');
const terminalAssetService = resolve(__dirname, '../src/services/terminalAssets.ios.ts');
const mermaidPreview = resolve(__dirname, '../src/components/MermaidPreview.tsx');

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

  it('packages the same terminal document as local files on iOS', () => {
    const androidHtml = readFileSync(resolve(assets, 'herdr-terminal.html'), 'utf8');
    const iosHtml = readFileSync(resolve(iosAssets, 'index.html'), 'utf8');

    expect(iosHtml).toBe(
      androidHtml.replace('  <base href="file:///android_asset/">\n', ''),
    );
    expect(iosHtml).toContain('<link rel="stylesheet" href="xterm.css">');
    expect(iosHtml).toContain('<script src="xterm.js"></script>');
    expect(iosHtml).toContain('<script src="addon-fit.js"></script>');
    expect(iosHtml).not.toContain('file:///android_asset/');
    expect(iosHtml).not.toContain('new Function(');
    expect(Buffer.byteLength(iosHtml)).toBeLessThan(100_000);
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

  it('selects the packaged terminal document for each native platform', () => {
    const renderer = readFileSync(terminalRenderer, 'utf8');
    const service = readFileSync(terminalAssetService, 'utf8');

    expect(renderer).toContain("android: { uri: 'file:///android_asset/herdr-terminal.html' }");
    expect(renderer).toContain("from '../services/terminalAssets'");
    expect(renderer).toContain("ios: { uri: IOS_TERMINAL_ASSETS?.indexURL || 'about:blank' }");
    expect(renderer).toContain('allowingReadAccessToURL={Platform.OS === \'ios\'');
    expect(renderer).toContain('source={TERMINAL_SOURCE}');
    expect(renderer).toContain("import WebView from 'react-native-webview'");
    expect(renderer).not.toContain('WebView.android');
    expect(renderer).not.toContain('IOS_TERMINAL_HTML_TEMPLATE');
    expect(service).toContain("requireNativeModule<TerminalAssetLocation>(");
    expect(service).toContain("'TerminalAssets'");
  });

  it('packages an offline Mermaid renderer with a restricted preview document', () => {
    const html = readFileSync(resolve(assets, 'mermaid-preview.html'), 'utf8');
    const runtime = readFileSync(resolve(assets, 'mermaid-preview.js'), 'utf8');
    const renderer = readFileSync(mermaidPreview, 'utf8');

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<script src="mermaid.min.js"></script>');
    expect(html).toContain('<script src="mermaid-preview.js"></script>');
    expect(runtime).toContain("securityLevel: 'strict'");
    expect(runtime).toContain('mermaid.render(id, source)');
    expect(renderer).toContain("android: { uri: 'file:///android_asset/mermaid-preview.html' }");
    expect(renderer).toContain("ios: { uri: IOS_TERMINAL_ASSETS?.mermaidURL || 'about:blank' }");
  });

  it('auto-links the iOS bridge and assets as a local Expo module', () => {
    const config = JSON.parse(
      readFileSync(resolve(iosModule, 'expo-module.config.json'), 'utf8'),
    );
    const podspec = readFileSync(
      resolve(iosModule, 'ios/WhipTerminalAssets.podspec'),
      'utf8',
    );
    const nativeModule = readFileSync(
      resolve(iosModule, 'ios/TerminalAssetsModule.swift'),
      'utf8',
    );
    const project = readFileSync(iosProject, 'utf8');

    expect(config).toEqual({
      platforms: ['apple'],
      apple: { modules: ['TerminalAssetsModule'] },
    });
    expect(podspec).toContain("s.dependency 'ExpoModulesCore'");
    expect(podspec).toContain("'WhipTerminalAssets' => ['TerminalAssets/**/*']");
    expect(nativeModule).toContain('public final class TerminalAssetsModule: Module');
    expect(nativeModule).toContain('Name("TerminalAssets")');
    expect(nativeModule).toContain('Constant("indexURL")');
    expect(nativeModule).toContain('Constant("mermaidURL")');
    expect(project).not.toContain('TerminalAssets in Resources');
    expect(project).not.toContain('TerminalAssetsModule.m in Sources');
  });

  it('compiles the generated Expo modules provider into the iOS app', () => {
    const project = readFileSync(iosProject, 'utf8');

    expect(project).toContain('ExpoModulesProvider.swift in Sources');
    expect(project).toContain('[Expo] Configure project');
    expect(project).toContain('expo-configure-project.sh');
  });

  it.each([
    'xterm.js',
    'xterm.css',
    'addon-fit.js',
    'mermaid.min.js',
    'mermaid-LICENSE.txt',
    'mermaid-preview.js',
    'jetbrains-mono-regular.ttf',
    'jetbrains-mono-bold.ttf',
    'symbols-nerd-font-mono-regular.ttf',
    'arphic-ukai-hk.ttf',
  ])('packages the same %s bytes for Android and iOS', file => {
    expect(
      readFileSync(resolve(iosAssets, file)).equals(
        readFileSync(resolve(assets, file)),
      ),
    ).toBe(true);
  });

  it('keeps Android text scaling from corrupting xterm character measurements', () => {
    const renderer = readFileSync(terminalRenderer, 'utf8');

    expect(renderer).toContain('textZoom={100}');
  });

  it('gives the multiplexed terminal host a viewport for absolute sessions', () => {
    const html = readFileSync(resolve(assets, 'herdr-terminal.html'), 'utf8');

    expect(html).toContain(
      '#terminals { position: relative; width: 100%; height: 100%; }',
    );
    expect(html).toContain('.terminal-session {\n      position: absolute;\n      inset: 0;');
  });

  it('coalesces terminal input before crossing the WebView bridge', () => {
    const html = readFileSync(resolve(assets, 'herdr-terminal.html'), 'utf8');

    expect(html).toContain("if (value.type === 'input' && typeof value.data === 'string')");
    expect(html).toContain('entry.pendingInput += value.data;');
    expect(html).toContain('setTimeout(() => flushInput(entry), 4)');
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
