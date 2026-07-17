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
      'Math.max(8, Math.min(16, Math.round(pinch.initialFontSize * ratio)))',
    );
    expect(assets).toContain('terminal.options.fontSize = fontSize');
    expect(assets).toContain("send({ type: 'font-size-change', fontSize })");
  });

  it('routes the final font size to the persisted terminal preferences', () => {
    const terminalScreen = readSource('src/components/TerminalScreen.tsx');
    const sessionScreen = readSource('src/components/SessionScreen.tsx');
    const app = readSource('App.tsx');

    expect(terminalScreen).toContain("message.type === 'font-size-change'");
    expect(terminalScreen).toContain(
      'onFontSizeChange(Math.max(8, Math.min(16, Math.round(fontSize))))',
    );
    expect(sessionScreen).toContain(
      'onFontSizeChange={onTerminalFontSizeChange}',
    );
    expect(app).toContain('onTerminalFontSizeChange={updateTerminalFontSize}');
    expect(app).toContain('setTerminalPreferences(current => (');
  });
});
