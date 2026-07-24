import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) =>
  readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal pinch zoom', () => {
  it('turns a two-finger distance change into a clamped xterm font size', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(assets).toContain('if (event.touches.length === 2)');
    expect(assets).toContain('touchDistance(event.touches) / pinch.distance');
    expect(assets).toContain(
      'Math.max(8, Math.min(24, Math.round(pinch.initialFontSize * ratio)))',
    );
    expect(assets).toContain('terminal.options.fontSize = fontSize');
    expect(assets).toContain("send({ type: 'font-size-change', fontSize })");
  });

  it('keeps the final font size local to its terminal instance', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');
    const sessionScreen = readSource('src/components/SessionScreen.tsx');
    const app = readSource('App.tsx');

    expect(renderer).toContain("message.type === 'font-size-change'");
    expect(renderer).toContain('entry.fontSize = Math.max(8, Math.min(24');
    expect(renderer).toContain('fontPreference: preferences.fontSize');
    expect(renderer).toContain('fontSize: preferences.fontSize');
    expect(sessionScreen).not.toContain('onTerminalFontSizeChange');
    expect(app).not.toContain('updateTerminalFontSize');
    expect(app).not.toContain('onTerminalFontSizeChange');
  });
});
