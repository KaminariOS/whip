import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) =>
  readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal keyboard layout', () => {
  test('shares the measured keyboard layout between terminal and chat viewports', () => {
    const terminalScreen = readSource('src/components/TerminalScreen.tsx');
    const sessionScreen = readSource('src/components/SessionScreen.tsx');

    expect(terminalScreen).not.toContain('useAnimatedKeyboard({');
    expect(terminalScreen).toContain('paddingBottom: keyboardInset');
    expect(terminalScreen).toContain('translateY: -keyboardInset');
    expect(terminalScreen).toContain(
      'bottom: TERMINAL_CONTROL_BAR_HEIGHT + bottomSafeAreaInset + keyboardInset',
    );
    expect(terminalScreen).toContain('{viewportOverlay}');
    expect(terminalScreen.indexOf('{viewportOverlay}')).toBeLessThan(
      terminalScreen.indexOf('ref={controlsRef}'),
    );
    expect(sessionScreen).toContain('viewportOverlay={activeChatView && activePane ? (');
  });
});
