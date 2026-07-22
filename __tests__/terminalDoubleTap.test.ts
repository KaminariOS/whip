import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) =>
  readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal double tap', () => {
  it('sends Tab after two nearby taps within the gesture timeout', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(assets).toContain('now.time - lastTap.time <= doubleTapTimeoutMs');
    expect(assets).toContain(
      'Math.hypot(now.x - lastTap.x, now.y - lastTap.y) <= doubleTapDistancePx',
    );
    expect(assets).toContain('doubleTapTabEnabled && lastTap');
    expect(assets).toContain("send({ type: 'input', data: '\\\\t' })");
  });

  it('can be disabled through live terminal preferences', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');
    const terminalScreen = readSource('src/components/TerminalScreen.tsx');

    expect(assets).toContain('doubleTapTabEnabled = options.doubleTapTab !== false');
    expect(assets).toContain('if (!doubleTapTabEnabled) lastTap = null');
    expect(terminalScreen).toContain('window.herdrConfigure(${JSON.stringify({ ...preferences, backgroundImageUri: null })})');
  });

  it('does not carry a tap through a swipe, long press, or cancelled touch', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(assets).toContain('touch.longPressed = true;\n        lastTap = null;');
    expect(assets).toContain('touch.moved = true;\n      lastTap = null;');
    expect(assets).toContain('pinch = null;\n      lastTap = null;');
  });
});
