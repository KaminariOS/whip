import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) =>
  readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal tap-to-click', () => {
  it('sends every stationary Herdr tap with its terminal cell while keyboard mode is off', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(assets).toContain('if (localScrollback || keyboardEnabled) return false');
    expect(assets).not.toContain('tapToClick');
    expect(assets).toContain("send({ type: 'terminal-click', column: cell.col, row: cell.row })");
    const clickHandler = assets.slice(
      assets.indexOf('const sendRemoteClick = point => {'),
      assets.indexOf('const dispatchTerminalMouse =', assets.indexOf('const sendRemoteClick = point => {')),
    );
    expect(clickHandler).not.toContain('terminal.focus()');
    expect(assets).toContain('if (!touch.moved && !touch.longPressed && point)');
    expect(assets).toContain('if (sendRemoteClick(point))');
    expect(assets).toContain("if (keyboardEnabled && event.touches.length === 1) terminal.focus()");
    expect(assets).toContain('if (!keyboardEnabled && terminalMouseCaptured())');
  });

  it('routes the click separately from scrolling and raw keyboard input', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');
    const client = readSource('src/services/HerdrClient.ts');

    expect(renderer).toContain("message.type === 'terminal-click'");
    expect(renderer).toContain('entry.target.client.clickTerminal(');
    expect(client).toContain('async clickTerminal(');
    expect(client).toContain('`\\u001b[<0;${sgrColumn};${sgrRow}M\\u001b[<0;${sgrColumn};${sgrRow}m`');
  });

  it('does not expose a terminal click setting', () => {
    const preferences = readSource('src/services/devicePreferences.ts');
    const settings = readSource('src/components/SettingsScreen.tsx');

    expect(preferences).not.toContain('tapToClick');
    expect(settings).not.toContain('tapToClick');
  });
});
