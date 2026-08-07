import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, `../${path}`), 'utf8');

describe('terminal renderer lifecycle', () => {
  it('mounts one global terminal WebView and preserves it across host switches', () => {
    const app = readSource('App.tsx');
    const session = readSource('src/components/SessionScreen.tsx');
    const terminal = readSource('src/components/TerminalScreen.tsx');
    const renderer = readSource('src/components/TerminalRendererHost.tsx');

    expect(app).toContain('{activeSession && activeRuntime && (');
    expect(app).toContain('terminalTargets={terminalTargets}');
    expect(app).not.toContain('key={session.id}');
    expect(session.match(/<TerminalScreen/g)).toHaveLength(1);
    expect(terminal).toContain('<TerminalRendererHost');
    expect(renderer.match(/\n {4}<WebView\n/g)).toHaveLength(1);
  });

  it('creates xterm containers on demand for the active terminal and swipe preview', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(renderer).not.toContain('for (const target of targets) ensureEntry(target);');
    expect(renderer).toContain('ensureEntry(activeTarget);');
    expect(renderer).toContain('ensureEntry(previewTarget);');
    expect(renderer).toContain('entries.current.set(target.key, entry);');
    expect(renderer).toContain('window.herdrCreate(');
    expect(assets).toContain("const root = document.createElement('div');");
    expect(assets).toContain("root.className = 'terminal-session';");
    expect(assets).toContain(
      'entry.api = createTerminalSession(root, value => receive(entry, value));',
    );
    expect(assets).toContain('const terminal = new Terminal({');
    expect(assets).toContain('const terminals = new Map();');
    expect(assets).toContain("send({ type: 'terminal-ready', key: entry.key });");
  });

  it('routes renderer commands and output by the host-terminal key', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(renderer).toContain('window.herdrWriteBase64Chunk(${key}');
    expect(renderer).toContain("entries.current.get(message.key)");
    expect(assets).toContain('window.herdrWriteBase64Chunk = (key, sequence, data, final)');
    expect(assets).toContain('const receive = (entry, value) =>');
    expect(assets).toContain('send({ ...value, key: entry.key });');
  });

  it('bounds xterm instances with a configurable LRU while keeping SSH bridges warm', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');
    const client = readSource('src/services/HerdrClient.ts');
    const preferences = readSource('src/services/devicePreferences.ts');
    const settings = readSource('src/components/SettingsScreen.tsx');

    expect(renderer).toContain('terminalRendererEvictionKeys(');
    expect(renderer).toContain('preferences.xtermCacheCapacity');
    expect(renderer).toContain('entry.target.client.detachTerminal(terminalId)');
    expect(renderer).toContain('window.herdrRemove(${JSON.stringify(key)})');
    expect(renderer).toContain('const knownTargets = useRef(new Map<string, TerminalRenderTarget>())');
    expect(renderer).toContain('target.client.closeTerminalBridge(target.session.terminalId)');
    expect(client).not.toContain('terminalBridgeLru');
    expect(preferences).toContain('xtermCacheCapacity: number;');
    expect(settings).toContain('function XtermCacheCapacityRow');
    expect(settings).toContain('Number.isSafeInteger(parsed)');
    expect(settings).toContain('inputMode="numeric"');
  });

  it('keeps each bridge open until its terminal or host closes', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');
    const client = readSource('src/services/HerdrClient.ts');

    expect(renderer).toContain('entry.target.client.detachTerminal');
    expect(client).toContain('async detachTerminal(terminalId: string)');
    expect(client).toContain('this.terminalConnections.delete(terminalId);');
    expect(client).toContain('this.client?.closeHerdrBridge(terminalId);');
    expect(client).toContain('this.client?.closeAllHerdrBridges()');
  });

  it('queues frames until the matching xterm instance is ready', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');

    expect(renderer).toContain('entry.pendingFrames.push(frame);');
    expect(renderer).toContain("if (message.type === 'terminal-ready')");
    expect(renderer).toContain('for (const frame of frames) injectFrame(entry, frame);');
    expect(renderer).toContain('const resetScript = reset ? `window.herdrReset(${key}); `');
  });

  it('pauses terminal resize commands while the app is backgrounded', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');

    expect(renderer).toContain('const appState = useRef(AppState.currentState);');
    expect(renderer).toContain('appState.current = state;');
    expect(renderer).toContain(
      "if (preferences.pauseResizeInBackground && appState.current !== 'active') return;",
    );
    expect(renderer).toContain(
      'entry.target.client.releaseTerminal(entry.target.session.terminalId)',
    );
    expect(renderer).toContain('preferences.pauseResizeInBackground');
    expect(renderer).toContain(
      '|| !entry.target.client.isTerminalBridgeRetained(entry.target.session.terminalId)',
    );
    expect(renderer).toContain(
      'if (preferences.pauseResizeInBackground && visible && activeKey.current)',
    );
    expect(renderer).toContain('window.herdrFit(${JSON.stringify(activeKey.current)});');
  });

  it('reattaches a deliberately released background controller without a reconnect overlay', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');

    expect(renderer).toContain('const connectEntry = useCallback((entry: RendererEntry, showConnecting = true) => {');
    expect(renderer).toContain('if (showConnecting) {');
    expect(renderer).toContain('connectEntry(entry, !preferences.pauseResizeInBackground);');
    expect(renderer).toContain("reportStatus(entry.target, 'disconnected', reason, nextAttempt);");
  });

  it('reattaches all terminal channels when the SSH control session is replaced', () => {
    const client = readSource('src/services/HerdrClient.ts');

    expect(client).toContain('const retainedTerminalIds = [...this.terminalBridges];');
    expect(client).toContain('for (const terminalId of retainedTerminalIds)');
    expect(client).toContain('await this.attachTerminal(terminalId);');
    expect(client).not.toContain("connection.onClosed?.('SSH control connection was replaced')");
  });

  it('reconciles a snapshot after an event stream reconnect', () => {
    const app = readSource('App.tsx');

    expect(app).toContain('await ensureEventStream(sessionId, session.snapshot, true);');
    expect(app).toContain('Events emitted while the stream was down cannot be replayed.');
    expect(app).toContain('await refreshHost(sessionId);');
  });

  it('keeps terminal focus bidirectional with Herdr', () => {
    const app = readSource('App.tsx');
    const session = readSource('src/components/SessionScreen.tsx');
    const client = readSource('src/services/HerdrClient.ts');

    expect(app).toContain("event.event === 'workspace.focused'");
    expect(session).toContain('client.focusPane(pane.pane_id)');
    expect(session).toContain('activateServerPane(serverPaneId)');
    expect(client).toContain('async focusPane(paneId: string)');
  });

  it('accepts Herdr pane focus when creating or closing a tab', () => {
    const session = readSource('src/components/SessionScreen.tsx');

    expect(session).toMatch(
      /else if \(workspace\) \{[\s\S]*?pendingPaneFocus\.current = null;[\s\S]*?client\.createTab/,
    );
    expect(session).toMatch(
      /const closeTab = async[\s\S]*?pendingPaneFocus\.current = null;[\s\S]*?client\.closeTab/,
    );
  });

  it('uses the full display while an active terminal is visible', () => {
    const app = readSource('App.tsx');
    const bottomNavigation = readSource('src/components/BottomNavigation.tsx');

    expect(app).toMatch(/fullscreenTerminalVisible\s*=\s*activeTerminalVisible\s*&&\s*terminalPreferences\.fullscreen/);
    expect(app).toMatch(/fullscreenVisible\s*=\s*immersiveTerminal\s*\?\s*fullscreenTerminalVisible\s*:\s*fullscreenApp/);
    expect(app).toContain('hidden={fullscreenVisible}');
    expect(app).toContain("edges={fullscreenVisible ? ['left', 'right'] : ['top', 'left', 'right']}");
    expect(app).toContain("style={immersiveTerminal ? styles.hiddenTab : styles.tabScreen}");
    expect(app).toContain("importantForAccessibility={immersiveTerminal ? 'no-hide-descendants' : 'auto'}");
    expect(bottomNavigation).toContain('style={{ bottom: 16, height: 120 + bottom, paddingBottom: bottom }}');
  });
});
