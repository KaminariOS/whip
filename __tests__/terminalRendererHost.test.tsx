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
});
