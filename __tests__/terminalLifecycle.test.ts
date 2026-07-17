import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal renderer lifecycle', () => {
  it('keeps one terminal WebView mounted per live host and retargets it', () => {
    const source = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');

    expect(source).toContain('session={activeTerminalSession || null}');
    expect(source).not.toContain('key={activeTerminalSession.terminalId}');
    expect(source).not.toContain('{visible && activeTerminalSession && (');
  });

  it('starts the remote bridge before a terminal is opened', () => {
    const source = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(source).toContain('runtime.client.prepareTerminalBridge().catch(() => undefined);');
  });

  it('keeps terminal focus bidirectional with Herdr', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const screen = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

    expect(app).toContain("event.event === 'workspace.focused'");
    expect(screen).toContain('client.focusPane(pane.pane_id)');
    expect(screen).toContain('activateServerPane(serverPaneId)');
    expect(client).toContain('async focusPane(paneId: string)');
  });

  it('attaches before WebView readiness and keeps terminal bridges after UI release', () => {
    const screen = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

    expect(screen).toContain('pendingFrames.current.push(frame)');
    expect(screen).not.toContain('if (!ready || !terminalId)');
    expect(client).toContain('this.terminalConnections.delete(terminalId)');
    expect(client).toContain('this.client?.closeHerdrBridge(terminalId)');
    expect(client).toContain('this.requireClient().herdrBridgeResize(\n      terminalId,');
  });
});
