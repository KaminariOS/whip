import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TerminalRendererHost } from '../src/components/TerminalRendererHost';
import type { TerminalRenderTarget } from '../src/lib/terminalRenderer';
import type { TerminalPreferences } from '../src/services/devicePreferences';

jest.mock('expo/virtual/env', () => ({ env: {} }));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  Clipboard: { setString: jest.fn() },
  Platform: {
    OS: 'android',
    select: (options: Record<string, unknown>) => options.android,
  },
}));
jest.mock('react-native-reanimated', () => ({
  useAnimatedReaction: jest.fn(),
}));
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (callback: (...args: unknown[]) => void, ...args: unknown[]) => callback(...args),
}));
jest.mock('react-native-webview', () => ({
  __esModule: true,
  default: 'WebView',
}));
jest.mock('../src/services/networkDiagnostics', () => ({
  networkErrorMessage: (reason: unknown) => String(reason),
  recordNetworkDiagnostic: jest.fn(),
}));
jest.mock('../src/services/performanceTrace', () => new Proxy(
  { __esModule: true },
  { get: (target, property) => property in target ? target[property as keyof typeof target] : jest.fn(() => null) },
));
jest.mock('../src/services/terminalAssets', () => ({ IOS_TERMINAL_ASSETS: null }));

const preferences: TerminalPreferences = {
  fullscreen: true,
  useModifierKeyIcons: false,
  volumeUpAction: 'none',
  volumeDownAction: 'none',
  fontSize: 14,
  scrollback: 2000,
  xtermCacheCapacity: 4,
  cursorBlink: true,
  doubleTapAction: 'none',
  openLinksInApp: false,
  pauseResizeInBackground: false,
  visualHints: false,
  backgroundImageUri: null,
  backgroundDimming: 0,
};

describe('TerminalRendererHost lifecycle', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test('closes the native bridge when a terminal target is removed', () => {
    const client = {
      closeTerminalBridge: jest.fn(async () => undefined),
      detachTerminal: jest.fn(async () => undefined),
      isTerminalBridgeRetained: jest.fn(() => false),
    };
    const target = {
      key: 'host-1:term-1',
      hostSessionId: 'host-1',
      client,
      session: {
        terminalId: 'term-1',
        paneId: 'pane-1',
        title: 'shell',
        kind: 'herdr',
        status: 'connected',
        reconnectAttempt: 0,
      },
    } as unknown as TerminalRenderTarget;
    const callbacks = {
      onInput: jest.fn(),
      onScroll: jest.fn(),
      onOfflineScroll: jest.fn(),
      onOfflineSnapshot: jest.fn(),
      onSearchResult: jest.fn(),
      onLinksScanned: jest.fn(),
      onOpenLink: jest.fn(),
      onPaste: jest.fn(),
      onBufferModeChange: jest.fn(),
      onProtocolStateChange: jest.fn(),
      onTitleChange: jest.fn(),
      onFontSizeChange: jest.fn(),
      onSelectionStateChange: jest.fn(),
      onStatus: jest.fn(),
      onError: jest.fn(),
    };

    act(() => {
      renderer = create(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={target}
          preferences={preferences}
          targets={[target]}
          visible
        />,
      );
    });
    expect(client.closeTerminalBridge).not.toHaveBeenCalled();

    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={null}
          preferences={preferences}
          targets={[]}
          visible
        />,
      );
    });

    expect(client.closeTerminalBridge).toHaveBeenCalledWith('term-1');
    expect(client.detachTerminal).not.toHaveBeenCalled();
  });

  test('updates visual insets without fitting or resizing the terminal', async () => {
    const injected: string[] = [];
    const client = {
      closeTerminalBridge: jest.fn(async () => undefined),
      detachTerminal: jest.fn(async () => undefined),
      isTerminalBridgeRetained: jest.fn(() => false),
    };
    const target = {
      key: 'host-1:term-1',
      hostSessionId: 'host-1',
      client,
      session: {
        terminalId: 'term-1',
        paneId: 'pane-1',
        title: 'shell',
        kind: 'herdr',
        status: 'connected',
        reconnectAttempt: 0,
      },
    } as unknown as TerminalRenderTarget;
    const callbacks = {
      onInput: jest.fn(),
      onScroll: jest.fn(),
      onOfflineScroll: jest.fn(),
      onOfflineSnapshot: jest.fn(),
      onSearchResult: jest.fn(),
      onLinksScanned: jest.fn(),
      onOpenLink: jest.fn(),
      onPaste: jest.fn(),
      onBufferModeChange: jest.fn(),
      onProtocolStateChange: jest.fn(),
      onTitleChange: jest.fn(),
      onFontSizeChange: jest.fn(),
      onSelectionStateChange: jest.fn(),
      onStatus: jest.fn(),
      onError: jest.fn(),
    };
    const visualViewport = {
      insets: { top: 55, bottom: 84 },
      geometryBottomInset: 84,
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 },
    };

    act(() => {
      renderer = create(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={target}
          preferences={preferences}
          targets={[target]}
          visible
          visualViewport={visualViewport}
        />,
        {
          createNodeMock: element => element.type === 'WebView' ? {
            injectJavaScript: (script: string) => injected.push(script),
            requestFocus: jest.fn(),
          } : null,
        },
      );
    });
    const webView = renderer.root.find(node => typeof node.props.onMessage === 'function');
    await act(async () => {
      await webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'ready' }) } });
    });
    injected.length = 0;

    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={target}
          preferences={preferences}
          targets={[target]}
          visible
          visualViewport={{
            ...visualViewport,
            alternateScreen: true,
            insets: { top: 92, bottom: 196 },
          }}
        />,
      );
    });

    expect(injected.join('\n')).toContain('window.herdrSetVisualInsets');
    expect(injected.join('\n')).toContain('"alternateScreen":true');
    expect(injected.join('\n')).toContain('"debug":false');
    expect(injected.join('\n')).not.toContain('window.herdrFit');
    expect(client).not.toHaveProperty('resizeTerminal');

    injected.length = 0;
    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={target}
          preferences={{ ...preferences, visualHints: true }}
          targets={[target]}
          visible
          visualViewport={visualViewport}
        />,
      );
    });

    expect(injected.join('\n')).toContain('"debug":true');
    expect(injected.join('\n')).not.toContain('window.herdrFit');
  });
});
