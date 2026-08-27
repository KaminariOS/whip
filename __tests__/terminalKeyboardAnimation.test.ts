import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) =>
  readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal keyboard layout', () => {
  test('shares the measured keyboard layout between terminal and chat viewports', () => {
    const terminalScreen = readSource('src/components/TerminalScreen.tsx');
    const sessionScreen = readSource('src/components/SessionScreen.tsx');

    expect(terminalScreen).not.toContain('useAnimatedKeyboard({');
    expect(terminalScreen).toContain('paddingBottom: terminalLayoutKeyboardInset');
    expect(terminalScreen).toContain('translateY: -keyboardInset');
    expect(terminalScreen).toContain(
      'const terminalLayoutKeyboardInset = composeOpen ? 0 : keyboardInset',
    );
    expect(terminalScreen).toContain('const floatingKeyboardInset = Math.max(0, keyboardInset - terminalLayoutKeyboardInset)');
    expect(terminalScreen).toContain('const terminalBottomChrome = terminalBottomChromeInset({');
    expect(terminalScreen).toContain('composerVisible: false,');
    expect(terminalScreen).toContain('keyboardInset: 0,');
    expect(terminalScreen).toContain('const viewportOverlayBottomChrome = terminalBottomChromeInset({');
    expect(terminalScreen).toContain('keyboardInset: floatingKeyboardInset,');
    expect(terminalScreen).toContain(
      'bottom: controlBarHeight + keyboardInset',
    );
    expect(terminalScreen).toContain('{viewportOverlay}');
    expect(terminalScreen.indexOf('{viewportOverlay}')).toBeLessThan(
      terminalScreen.indexOf('ref={controlsRef}'),
    );
    expect(sessionScreen).toContain('renderViewportOverlay={activeChatView && activePane ? insets => (');
    expect(sessionScreen).toContain('contentInsets={insets}');
  });

  test('opening the floating composer preserves terminal geometry', () => {
    const terminalScreen = readSource('src/components/TerminalScreen.tsx');

    expect(terminalScreen).toContain('if (enteredVisibility && !composeOpenRef.current)');
    expect(terminalScreen).toContain('}, [getComposerDraft, ready, terminalId, visible]);');
    expect(terminalScreen).not.toContain(
      '}, [composeOpen, getComposerDraft, ready, terminalId, visible]);',
    );
    expect(terminalScreen).toContain('insets: terminalScrollingInsets');
    expect(terminalScreen).toContain('renderViewportOverlay?.(viewportOverlayInsets)');
  });
});
