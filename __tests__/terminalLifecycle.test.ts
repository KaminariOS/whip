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

  it('creates one xterm container and one channel for every open terminal', () => {
    const renderer = readSource('src/components/TerminalRendererHost.tsx');
    const assets = readSource('scripts/sync-terminal-assets.mjs');

    expect(renderer).toContain('for (const target of targets) ensureEntry(target);');
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

  it('has no WebView or SSH-channel retention limit', () => {
    const app = readSource('App.tsx');
    const client = readSource('src/services/HerdrClient.ts');
    const preferences = readSource('src/services/devicePreferences.ts');

    expect(app).not.toContain('TerminalBridgeRetention');
    expect(app).not.toContain('terminalSurfaceLru');
    expect(client).not.toContain('terminalBridgeLru');
    expect(client).not.toContain('TerminalBridgeRetention');
    expect(preferences).not.toContain('retainedSshBridges');
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

  it('keeps hidden terminals at immersive height while bottom navigation is visible', () => {
    const app = readSource('App.tsx');
    const bottomNavigation = readSource('src/components/BottomNavigation.tsx');

    expect(app).toContain("edges={['top', 'left', 'right']}");
    expect(app).toContain('{!immersiveTerminal && (');
    expect(bottomNavigation).toContain('style={{ minHeight: 66 + bottom, paddingBottom: bottom }}');
  });
});
