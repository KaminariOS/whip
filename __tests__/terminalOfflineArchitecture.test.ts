import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('terminal offline architecture', () => {
  test('connected TerminalScreen has no pane-read polling path', () => {
    const screen = source('src/components/TerminalScreen.tsx');

    expect(screen).not.toContain('.readPane(');
    expect(screen).not.toMatch(/setInterval\s*\([^)]*readPane/s);
    expect(screen).not.toContain('15000');
  });

  test('the WebView cache is live-write driven and lifecycle snapshots are explicit', () => {
    const assets = source('scripts/sync-terminal-assets.mjs');
    const host = source('src/components/TerminalRendererHost.tsx');

    expect(assets).toContain('offlineCache.markDirty();');
    expect(assets).toContain('window.herdrSnapshot = reason =>');
    expect(host).toContain('"eviction"');
    expect(host).toContain('"background"');
  });

  test('generated Android and iOS terminal assets include the same cache runtime', () => {
    const android = source('android/app/src/main/assets/herdr-terminal.html');
    const ios = source('modules/whip-terminal-assets/ios/TerminalAssets/index.html');

    for (const generated of [android, ios]) {
      expect(generated).toContain('<script src="addon-serialize.js"></script>');
      expect(generated).toContain("type: 'cache-snapshot'");
      expect(generated).toContain('offlineCache.markDirty();');
    }
  });

  test('warm state is tracked separately from a cold cache reconstruction', () => {
    const host = source('src/components/TerminalRendererHost.tsx');

    expect(host).toContain('entry.contentState.receivedLiveFrame();');
    expect(host).toContain('entry.contentState.restoreAction(');
    expect(host).toContain('entry.contentState.restoredFromCache();');
  });
});
