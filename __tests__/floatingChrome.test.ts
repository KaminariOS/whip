import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

import {
  insetContentPadding,
  sessionTopChromeInset,
  terminalBottomChromeInset,
  terminalControlBarInset,
  visualContentInsets,
} from '../src/lib/floatingChrome';

const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('floating chrome geometry', () => {
  test('uses one tab-bar height and adds the pane bar only for multiple panes', () => {
    expect(sessionTopChromeInset(0)).toBe(55);
    expect(sessionTopChromeInset(1)).toBe(55);
    expect(sessionTopChromeInset(2)).toBe(92);
  });

  test('includes iOS safe area, keyboard, and a dynamically measured composer', () => {
    const controlBarHeight = terminalControlBarInset(34);
    expect(controlBarHeight).toBe(84);
    expect(terminalBottomChromeInset({
      composerHeight: 112,
      composerVisible: true,
      controlBarHeight,
      keyboardInset: 301,
    })).toBe(497);
    expect(terminalBottomChromeInset({
      composerHeight: 112,
      composerVisible: false,
      controlBarHeight,
      keyboardInset: 0,
    })).toBe(84);
  });

  test('chat boundary padding places first and last content outside occluded regions', () => {
    const insets = visualContentInsets(92, 186);
    expect(insetContentPadding(insets, { top: 16, bottom: 24 })).toEqual({
      top: 108,
      bottom: 210,
    });
  });

  test('chat viewport remains edge-to-edge and only its scroll content is inset', () => {
    const terminal = source('src/components/TerminalScreen.tsx');
    const chat = source('src/components/AgentChatView.tsx');

    expect(terminal).toContain('className="absolute inset-0 z-20"');
    expect(terminal).not.toContain('style={{ top: topOverlayInset }}');
    expect(chat).toContain('<ChatBoundarySpacer height={contentPadding.top} />');
    expect(chat).toContain('ListFooterComponent={<ChatBoundarySpacer height={contentPadding.bottom} />}');
    expect(chat).not.toContain('paddingTop: contentPadding.top');
    expect(chat).not.toContain('paddingBottom: contentPadding.bottom');
    expect(chat).toContain('scrollIndicatorInsets={contentInsets}');
  });

  test('terminal assets separate visual offsets from their fitted geometry reserve', () => {
    const generator = source('scripts/sync-terminal-assets.mjs');

    expect(generator).toContain("transform: translateY(var(--terminal-visual-offset, 0px))");
    expect(generator).toContain('transition: transform 120ms cubic-bezier(0.2, 0, 0, 1)');
    expect(generator).toContain('height: calc(100% - var(--terminal-geometry-bottom, 0px))');
    expect(generator).toContain('.terminal-session #terminal-geometry {');
    expect(generator).toContain('const bottomAllowance = Math.max(0, finiteInset(terminalVisualInsets.bottom) - geometryBottom)');
    expect(generator).toContain('html, body, #terminals, .terminal-session #terminal-geometry, .terminal-session #terminal {');
    expect(generator).not.toContain("entry.root.style.bottom = geometryBottomInset + 'px'");
    expect(generator).toContain("terminal.buffer.active.type === 'alternate'");
    expect(generator).toContain('terminalVisualInsets.alternateScreen || terminal.buffer.active.type');
    expect(generator).toContain("send({ type: 'visual-insets-debug', ...state })");
    expect(generator).toContain("debug.style.display = terminalVisualInsets.debug ? 'block' : 'none'");
    expect(generator).toContain("geometryElement.style.setProperty('--terminal-visual-offset', '0px')");
    expect(generator).toContain('Math.min(Math.max(1, terminal.rows), remoteVisualPendingDelta + visualDelta)');
    expect(generator).toContain('normalizedInputOffset + remoteVisualPendingDelta');

    for (const asset of [
      source('android/app/src/main/assets/herdr-terminal.html'),
      source('modules/whip-terminal-assets/ios/TerminalAssets/index.html'),
    ]) {
      expect(asset).toContain('html, body, #terminals, .terminal-session #terminal-geometry, .terminal-session #terminal {');
      expect(asset).toContain('api.herdrSetVisualInsets = options =>');
      expect(asset).toContain('height: calc(100% - var(--terminal-geometry-bottom, 0px))');
      expect(asset).toContain('transition: transform 120ms cubic-bezier(0.2, 0, 0, 1)');
      expect(asset).toContain('.terminal-session #terminal-geometry {');
      expect(asset).not.toContain("entry.root.style.bottom = geometryBottomInset + 'px'");
      expect(asset).toContain('terminalVisualInsets.alternateScreen || terminal.buffer.active.type');
      expect(asset).toContain("send({ type: 'visual-insets-debug', ...state })");
      expect(asset).toContain("terminalVisualBoundaryPreference = direction === 'up' ? 'top' : 'bottom'");
      expect(asset).toContain('Math.min(Math.max(1, terminal.rows), remoteVisualPendingDelta + visualDelta)');
      expect(asset).toContain('normalizedInputOffset + remoteVisualPendingDelta');
      expect(asset).toContain("if (offlineScrollback) {\n        terminal.scrollLines");
      expect(asset).toContain("if (localScrollback) terminal.scrollLines");
      expect(asset).toContain("send({ type: 'scroll', direction, lines: count");
    }
  });

  test('generated terminal inline scripts remain syntactically valid', () => {
    for (const path of [
      'android/app/src/main/assets/herdr-terminal.html',
      'modules/whip-terminal-assets/ios/TerminalAssets/index.html',
    ]) {
      const asset = source(path);
      const inlineScript = asset.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(inlineScript).toBeDefined();
      expect(() => new Script(inlineScript as string)).not.toThrow();
    }
  });

  test('custom scrollbars use occlusion only for track placement', () => {
    const terminal = source('src/components/TerminalScreen.tsx');
    const chat = source('src/components/AgentChatView.tsx');
    const scrollbar = source('src/components/OverlayScrollbar.tsx');

    expect(terminal).toContain('insets={scrollingInsets}');
    expect(chat).toContain('insets={contentInsets}');
    expect(scrollbar).toContain('insets ? { bottom: insets.bottom, top: insets.top } : undefined');
  });

  test('custom scrollbars default to a thicker low-opacity glass thumb and large grab target', () => {
    const scrollbar = source('src/components/OverlayScrollbar.tsx');

    expect(scrollbar).toContain('glass = true');
    expect(scrollbar).toContain('const IDLE_WIDTH = 14;');
    expect(scrollbar).toContain('const ACTIVE_WIDTH = 22;');
    expect(scrollbar).toContain('const HIT_TARGET_WIDTH = 40;');
    expect(scrollbar).toContain('const MIN_HIT_TARGET_HEIGHT = 44;');
    expect(scrollbar).toContain('const GLASS_OPACITY = 0.58;');
    expect(scrollbar).toContain('const glassEnabled = glass && !interacting;');
    expect(scrollbar).toContain('setInteracting(true);');
    expect(scrollbar).toContain('setInteracting(false);');
    expect(scrollbar).toContain('borderWidth: StyleSheet.hairlineWidth');
  });

  test('composer measurement is guarded and does not participate in a fit effect', () => {
    const terminal = source('src/components/TerminalScreen.tsx');

    expect(terminal).toContain('setComposerHeight(current => current === height ? current : height)');
    expect(terminal).toContain('terminalLayoutKeyboardInset = composeOpen ? 0 : keyboardInset');
    expect(terminal).not.toMatch(/useEffect\(\(\) => \{[\s\S]*?renderer\.current\?\.fit\(\)[\s\S]*?\}, \[[^\]]*composerHeight/s);
    expect(terminal).not.toMatch(/useEffect\(\(\) => \{[\s\S]*?renderer\.current\?\.fit\(\)[\s\S]*?\}, \[[^\]]*scrollingInsets/s);
  });
});
