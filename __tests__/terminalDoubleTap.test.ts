import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) =>
  readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal double tap', () => {
  it('runs the configured action after two nearby taps within the gesture timeout', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(assets).toContain('now.time - lastTap.time <= doubleTapTimeoutMs');
    expect(assets).toContain(
      'Math.hypot(now.x - lastTap.x, now.y - lastTap.y) <= doubleTapDistancePx',
    );
    expect(assets).toContain("doubleTapAction !== 'none' && lastTap");
    expect(assets).toContain("doubleTapAction === 'paste'");
    expect(assets).toContain("send({ type: 'clipboard-read' })");
    expect(assets).toContain("doubleTapAction === 'escape' ? '\\\\u001b' : '\\\\t'");
  });

  it('supports all actions through live terminal preferences', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');
    const renderer = readSource('src/components/TerminalRendererHost.tsx');
    const settings = readSource('src/components/SettingsScreen.tsx');

    expect(assets).toContain("['none', 'paste', 'tab', 'escape'].includes(options.doubleTapAction)");
    expect(assets).toContain("if (doubleTapAction === 'none') lastTap = null");
    expect(renderer).toContain('window.herdrConfigure(${JSON.stringify(entry.target.key)}');
    expect(renderer).toContain('...preferences,');
    expect(renderer).toContain('fontSize: entry.fontSize');
    expect(settings).toContain('terminalDoubleTapActions.map');
    expect(settings).toContain('doubleTapAction: action');
    expect(settings).toContain('accessibilityState={{ expanded }}');
    expect(settings).toContain('{expanded ? (');
    expect(settings).toContain('setDoubleTapExpanded(expanded => !expanded)');
    expect(settings).toContain('LayoutAnimation.configureNext(DOUBLE_TAP_MENU_ANIMATION)');
    expect(settings).toContain('LayoutAnimation.Types.easeInEaseOut');
    expect(settings).toContain('useReducedMotion()');
  });

  it('does not carry a tap through a swipe, long press, or cancelled touch', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(assets).toMatch(/touch\.longPressed = true;\s+lastTap = null;/);
    expect(assets).toContain('touch.moved = true;\n      lastTap = null;');
    expect(assets).toContain('pinch = null;\n      lastTap = null;');
  });
});
