import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) =>
  readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal keyboard animation', () => {
  test('tracks the Android keyboard on the UI thread and resizes only the presented terminal', () => {
    const terminalScreen = readSource('src/components/TerminalScreen.tsx');
    const terminalAssets = readSource('scripts/sync-terminal-assets.mjs');

    expect(terminalScreen).toContain('useAnimatedKeyboard({');
    expect(terminalScreen).toContain('paddingBottom: animatedKeyboardInset.value');
    expect(terminalScreen).toContain('translateY: -animatedKeyboardInset.value');
    expect(terminalAssets).toContain('if (terminalIsPresented()) resize();');
    expect(terminalAssets).toContain("window.addEventListener('resize', resizePresentedTerminal)");
  });
});
