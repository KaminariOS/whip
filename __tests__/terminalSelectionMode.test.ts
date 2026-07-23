import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal selection mode', () => {
  it('extends a long-pressed word into a range while keyboard input is disabled', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(assets).toContain('const selectRangeTo = (selection, cell) =>');
    expect(assets).toContain('if (touch.longPressed && !keyboardEnabled)');
    expect(assets).toContain('selectRangeTo(touch.selection, cell)');
    expect(assets).toContain('terminal.select(start.col, start.row');
  });

  it('opens a tapped terminal URL through the existing link routing', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');
    const terminal = readSource('src/components/TerminalScreen.tsx');
    const session = readSource('src/components/SessionScreen.tsx');

    expect(assets).toContain('const urlAtPoint = (x, y) =>');
    expect(assets).toContain("send({ type: 'open-link', link })");
    expect(terminal).toContain("message.type === 'open-link'");
    expect(session).toContain('onOpenLink={link =>');
    expect(session).toContain('openTerminalLink(link)');
  });
});
