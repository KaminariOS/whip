import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal renderer lifecycle', () => {
  it('keeps one terminal WebView mounted per opened terminal', () => {
    const source = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');

    expect(source).toContain('terminalState.sessions.map(terminalSession => (');
    expect(source).toContain('key={terminalSession.terminalId}');
    expect(source).toContain('session={terminalSession}');
    expect(source).toContain("!visible && 'absolute inset-0 opacity-0'");
    expect(source).not.toContain("!visible && 'hidden'");
  });

  it('hands keyboard focus between persistent terminal renderers', () => {
    const screen = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');
    const assets = readFileSync(resolve(__dirname, '../scripts/sync-terminal-assets.mjs'), 'utf8');

    expect(screen).toContain("window.herdrBlur(); true;");
    expect(screen).toContain("window.herdrFocus();");
    expect(assets).toContain('window.herdrBlur = () => terminal.blur();');
  });

  it('starts the remote bridge before a terminal is opened', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

    expect(app).toContain('runtime.client.prepareTerminalBridge().catch(() => undefined);');
    expect(client).toContain('if (preparing) await preparing.catch(() => undefined);');
  });

  it('reconciles a snapshot after an event stream reconnect', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(app).toContain('await ensureEventStream(sessionId, session.snapshot, true);');
    expect(app).toContain('Events emitted while the stream was down cannot be replayed.');
    expect(app).toContain('await refreshHost(sessionId);');
  });

  it('opens the active terminal immediately after selecting a saved host', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(app).toContain("if (navigate) setNavigation(current => selectMobileTab(current, 'terminal'));");
    expect(app).toContain("selectLiveHost(existing.id, 'terminal');");
  });

  it('keeps terminal focus bidirectional with Herdr', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const screen = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

    expect(app).toContain("event.event === 'workspace.focused'");
    expect(screen).toContain('client.focusPane(pane.pane_id)');
    expect(screen).toContain('activateServerPane(serverPaneId)');
    expect(client).toContain('async focusPane(paneId: string)');
    expect(app).toContain('.catch(error => scheduleReconnect(sessionId, error));');
  });

  it('reattaches terminals transparently when the SSH control session is replaced', () => {
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

    expect(client).toContain('private controlReconnect: Promise<void> | null = null');
    expect(client).toContain('await this.attachTerminal(terminalId)');
    expect(client).toContain('if (reconnecting) await reconnecting');
    expect(client).not.toContain("connection.onClosed?.('SSH control connection was replaced')");
  });

  it('does not replace the SSH client while its initial handshake is running', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

    expect(app).toContain('if (!runtime || !canRefreshLiveHostSession(session)) return;');
    expect(client).toContain('private controlConnect: Promise<void> | null = null;');
    expect(client).toContain('const connecting = this.controlConnect;');
    expect(client).toContain('await connecting;\n        return;');
  });

  it('attaches before WebView readiness and detaches the controller after UI release', () => {
    const screen = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

    expect(screen).toContain('pendingFrames.current.push(frame)');
    expect(screen).not.toContain('if (!ready || !terminalId)');
    expect(client).toContain('this.terminalConnections.get(terminalId) !== connection');
    expect(client).toContain('this.terminalConnections.delete(terminalId)');
    expect(client).toContain('this.client?.closeHerdrBridge(terminalId)');
    expect(client).toContain('this.client?.closeAllHerdrBridges()');
    expect(client).toContain('this.requireClient().herdrBridgeResize(\n      terminalId,');
  });

  it('resets the renderer in the same injection as the first terminal frame', () => {
    const screen = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');

    expect(screen).toContain('const resetOnNextFrame = useRef(true);');
    expect(screen).toContain("const resetScript = reset ? 'window.herdrReset(); ' : '';");
    expect(screen).not.toContain("if (readyRef.current) webView.current?.injectJavaScript('window.herdrReset(); true;');");
  });
});
