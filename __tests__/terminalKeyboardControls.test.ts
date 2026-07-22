import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal keyboard controls', () => {
  it('keeps the terminal surface and control row above an overlapping keyboard', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/TerminalScreen.tsx'),
      'utf8',
    );
    const manifest = readFileSync(
      resolve(__dirname, '../android/app/src/main/AndroidManifest.xml'),
      'utf8',
    );

    const webView = screen.indexOf('      <WebView\n');
    const controlsWrapper = screen.indexOf('ref={controlsRef}');
    const controls = screen.indexOf('{controlOrder.map(renderTerminalControl)}');

    expect(screen).toContain('event.endCoordinates.screenY');
    expect(screen).toContain('controlsRef.current?.measureInWindow');
    expect(screen).toContain(
      'setKeyboardInset(Math.max(0, Math.ceil(y + height - keyboardTop)))',
    );
    expect(screen).toContain(
      'style={keyboardInset > 0 ? { marginBottom: keyboardInset } : undefined}',
    );
    expect(screen).toContain('contentContainerStyle={{ paddingBottom: 7 + (keyboardVisible ? 0 : bottomSafeAreaInset) }}');
    expect(screen).toContain("source={{ uri: preferences.backgroundImageUri }}");
    expect(screen).toContain('backgroundImageUri: null');
    expect(webView).toBeGreaterThanOrEqual(0);
    expect(controlsWrapper).toBeGreaterThan(webView);
    expect(controls).toBeGreaterThan(controlsWrapper);
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
  });

  it('renders controls in their persisted frequency order and records presses', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/TerminalScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain(
      'const [controlOrder] = useState(() => orderTerminalControls(controlUsage));',
    );
    expect(screen).toContain('{controlOrder.map(renderTerminalControl)}');
    expect(screen).toContain('onControlUse(control);');
    expect(screen).not.toContain('CTRL+C');
  });
});
