import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('alternate-screen terminal scrolling', () => {
  const assets = readFileSync(
    resolve(__dirname, '../scripts/sync-terminal-assets.mjs'),
    'utf8',
  );

  it('turns scroll gestures into wheel input for full-screen TUIs', () => {
    expect(assets).toContain("terminal.buffer.active.type !== 'alternate' && terminal.modes.mouseTrackingMode === 'none'");
    expect(assets).toContain("terminal.element.dispatchEvent(new WheelEvent('wheel'");
    expect(assets).toContain('deltaMode: WheelEvent.DOM_DELTA_LINE');
    expect(assets).toContain(
      "scrollTerminal(lines > 0 ? 'up' : 'down', Math.abs(lines), point)",
    );
  });

  it('keeps normal-buffer local and remote scrollback behavior', () => {
    const alternateScroll = assets.indexOf('if (dispatchTerminalWheel(direction, count, point)) return;');
    const localScroll = assets.indexOf("if (localScrollback) terminal.scrollLines(direction === 'up' ? -count : count);");
    const remoteScroll = assets.indexOf(
      "send({ type: 'scroll', direction, lines: count, column: cell?.col, row: cell?.row });",
      localScroll,
    );

    expect(alternateScroll).toBeGreaterThanOrEqual(0);
    expect(localScroll).toBeGreaterThan(alternateScroll);
    expect(remoteScroll).toBeGreaterThan(localScroll);
  });

  it('uses only the rendered terminal mouse mode for taps and drags', () => {
    expect(assets).toContain("const terminalMouseCaptured = () => terminal.modes.mouseTrackingMode !== 'none'");
    expect(assets).not.toContain('remoteMouseCapture');
    expect(assets).toContain("dispatchTerminalMouse('down', { clientX: touch.x, clientY: touch.y })");
    expect(assets).toContain("dispatchTerminalMouse('move', point)");
    expect(assets).toContain("dispatchTerminalMouse('up', point)");
    expect(assets).toContain('else if (terminalMouseCaptured()) dispatchTerminalClick(point)');
  });

  it('sends the touched terminal cell with remote wheel requests', () => {
    expect(assets).toContain("send({ type: 'scroll', direction, lines: count, column: cell?.col, row: cell?.row })");
    expect(assets).toContain('Math.min(terminal.cols - 1');
    expect(assets).toContain('Math.min(terminal.rows - 1');
  });

  it('reports alternate-buffer transitions to native UI state', () => {
    expect(assets).toContain('terminal.buffer.onBufferChange(buffer => {');
    expect(assets).toContain("send({ type: 'buffer-mode', alternate: buffer.type === 'alternate' })");
  });
});
