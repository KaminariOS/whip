import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal keyboard controls', () => {
  it('floats the control row above an overlapping keyboard without resizing the terminal', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/TerminalScreen.tsx'),
      'utf8',
    );
    const manifest = readFileSync(
      resolve(__dirname, '../android/app/src/main/AndroidManifest.xml'),
      'utf8',
    );

    const renderer = screen.indexOf('        <TerminalRendererHost\n');
    const controlsWrapper = screen.indexOf('ref={controlsRef}');
    const controls = screen.indexOf('{controlOrder.map(renderTerminalControl)}');

    expect(screen).toContain('event.endCoordinates.screenY');
    expect(screen).toContain('controlsRef.current?.measureInWindow');
    expect(screen).toContain(
      'setKeyboardInset(Math.max(0, Math.ceil(y + height - keyboardTop)))',
    );
    expect(screen).toContain(
      'style={keyboardInset > 0 ? { transform: [{ translateY: -keyboardInset }] } : undefined}',
    );
    expect(screen).toContain('contentContainerStyle={{ paddingBottom: 7 + bottomSafeAreaInset }}');
    expect(screen).toContain("source={{ uri: preferences.backgroundImageUri }}");
    expect(renderer).toBeGreaterThanOrEqual(0);
    expect(controlsWrapper).toBeGreaterThan(renderer);
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
    expect(screen).toContain('border border-border bg-card/70');
    expect(screen).toContain('active:bg-card/80');
    expect(screen).toContain("ctrl === 'locked' && 'border-primary bg-primary/70 active:bg-primary/80'");
    expect(screen).toContain("ctrl === 'locked' && 'text-primary-foreground'");
    expect(screen).toContain("shift === 'locked' && 'border-primary bg-primary/70 active:bg-primary/80'");
    expect(screen).toContain("if (control === 'attach')");
    expect(screen).toContain("if (control === 'files')");
    expect(screen).toContain("if (control === 'keyboard')");
    expect(screen).toContain('const [ctrl, ctrlRef, setCtrl] = useTerminalModifierState()');
    expect(screen).toContain('const activeTargetRef = useRef(activeTarget)');
    expect(screen).toContain('activeTargetRef.current = activeTarget');
    expect(screen).toContain("target.key !== activeTargetRef.current?.key");
    expect(screen).toContain('ctrlRef.current,');
    expect(screen).toContain("if (ctrlRef.current === 'armed') setCtrl('off')");
    expect(screen).not.toContain('CTRL+C');
  });

  it('starts in selection mode and can enable terminal keyboard input', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/TerminalScreen.tsx'),
      'utf8',
    );
    const assets = readFileSync(
      resolve(__dirname, '../scripts/sync-terminal-assets.mjs'),
      'utf8',
    );

    expect(screen).toContain('const [keyboardEnabled, setKeyboardEnabled] = useState(false)');
    expect(screen).toContain('renderer.current?.setKeyboardEnabled(keyboardEnabled)');
    expect(screen).toContain('Keyboard.dismiss()');
    expect(screen).toContain('{...(keyboardEnabled ? terminalPanHandlers : undefined)}');
    expect(assets).toContain('let keyboardEnabled = false');
    expect(assets).toContain('window.herdrSetKeyboardEnabled = enabled =>');
    expect(assets).toContain('if (!keyboardEnabled) terminal.blur()');
  });

  it('opens a terminal with the keyboard hidden until the user focuses it', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/TerminalScreen.tsx'),
      'utf8',
    );

    const visibilityEffect = screen.slice(
      screen.indexOf("if (!ready) {\n      wasVisible.current = visible;"),
      screen.indexOf('renderer.current?.setKeyboardEnabled(keyboardEnabled);'),
    );
    expect(visibilityEffect).toContain('renderer.current?.blur();');
    expect(visibilityEffect).toContain('Keyboard.dismiss();');
    expect(visibilityEffect).not.toContain('renderer.current?.focus();');

    const assets = readFileSync(
      resolve(__dirname, '../scripts/sync-terminal-assets.mjs'),
      'utf8',
    );
    expect(assets).toContain(
      'if (!touch.moved && !touch.longPressed && point) {\n        terminal.focus();',
    );
  });

  it('keeps the composer from reopening the keyboard while selection mode is active', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/TerminalScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('const composeInputRef = useRef<TextInputHandle | null>(null)');
    expect(screen).toContain('ref={composeInputRef}');
    expect(screen).toContain('autoFocus={keyboardEnabled}');
    expect(screen).toContain('showSoftInputOnFocus={keyboardEnabled}');
    expect(screen).toContain('if (composeOpen) {');
    expect(screen).toContain('composeInputRef.current?.focus()');
  });
});
