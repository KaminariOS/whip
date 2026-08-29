import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { TerminalRendererHost } from '../src/components/TerminalRendererHost';
import type { TerminalFrame } from '../src/lib/terminalBridge';
import type { TerminalRenderTarget } from '../src/lib/terminalRenderer';
import type { TerminalPreferences } from '../src/services/devicePreferences';

jest.mock('expo/virtual/env', () => ({ env: {} }));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => {
  const mockListeners = new Set<(mockState: string) => void>();
  return {
    AppState: {
      currentState: 'active',
      listeners: mockListeners,
      addEventListener: jest.fn((_event: string, listener: (state: string) => void) => {
        mockListeners.add(listener);
        return { remove: () => mockListeners.delete(listener) };
      }),
    },
    Clipboard: { setString: jest.fn() },
    Platform: {
      OS: 'android',
      select: (options: Record<string, unknown>) => options.android,
    },
  };
});
jest.mock('react-native-reanimated', () => ({
  useAnimatedReaction: jest.fn(),
}));
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    callback(...args),
}));
jest.mock('react-native-webview', () => ({
  __esModule: true,
  default: 'WebView',
}));
jest.mock('../src/services/networkDiagnostics', () => ({
  networkErrorMessage: (reason: unknown) => String(reason),
  recordNetworkDiagnostic: jest.fn(),
}));
jest.mock(
  '../src/services/performanceTrace',
  () =>
    new Proxy(
      { __esModule: true },
      {
        get: (target, property) =>
          property in target
            ? target[property as keyof typeof target]
            : jest.fn(() => null),
      },
    ),
);
jest.mock('../src/services/terminalAssets', () => ({
  IOS_TERMINAL_ASSETS: null,
}));

const mockAppState = jest.requireMock('react-native').AppState as {
  currentState: string;
  listeners: Set<(state: string) => void>;
  addEventListener: jest.Mock;
};

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

  beforeEach(() => {
    mockAppState.currentState = 'active';
    mockAppState.listeners.clear();
    mockAppState.addEventListener.mockClear();
  });

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  const createCallbacks = () => ({
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
  });

  const createClient = (
    paneScrolls: Record<
      string,
      {
        offset_from_bottom: number;
        max_offset_from_bottom: number;
        viewport_rows: number;
      }
    >,
  ) => {
    let retained = false;
    let nextAttachmentId = 0;
    let frameHandler: ((frame: TerminalFrame) => void) | null = null;
    const closeTerminalBridge = jest.fn(async () => undefined);
    const detachTerminal = jest.fn(
      async (_terminalId: string, _attachmentId: unknown): Promise<void> =>
        undefined,
    );
    const isTerminalBridgeRetained = jest.fn(() => retained);
    const openTerminal = jest.fn(
      async (
        _terminalId: string,
        onFrame: (frame: TerminalFrame) => void,
      ) => {
        retained = true;
        frameHandler = onFrame;
        return { testAttachmentId: ++nextAttachmentId };
      },
    );
    const releaseTerminal = jest.fn(
      async (_terminalId: string, _attachmentId: unknown): Promise<void> => {
        retained = false;
      },
    );
    const resizeTerminal = jest.fn(async () => undefined);
    const scrollTerminal = jest.fn(async () => '');
    return {
      terminal: {
        closeTerminalBridge,
        detachTerminal,
        isTerminalBridgeRetained,
        openTerminal,
        releaseTerminal,
        resizeTerminal,
        scrollTerminal,
      },
      native: {
        requestHerdrApi: jest.fn(async () => ({ type: 'ok' as const })),
        submitPastes: jest.fn(async () => undefined),
      },
      closeTerminalBridge,
      detachTerminal,
      isTerminalBridgeRetained,
      emitFrame: (frame: TerminalFrame) => frameHandler?.(frame),
      openTerminal,
      releaseTerminal,
      resizeTerminal,
      scrollTerminal,
      snapshot: jest.fn(async () => ({
        panes: Object.entries(paneScrolls).map(([terminalId, scroll]) => ({
          terminal_id: terminalId,
          scroll,
        })),
      })),
    };
  };

  const createTarget = (
    terminalId: string,
    client: ReturnType<typeof createClient>,
    scroll: {
      offset_from_bottom: number;
      max_offset_from_bottom: number;
      viewport_rows: number;
    },
  ) =>
    ({
      key: `host-1:${terminalId}`,
      hostSessionId: 'host-1',
      client,
      session: {
        terminalId,
        paneId: `pane-${terminalId}`,
        title: 'shell',
        kind: 'herdr',
        status: 'connected',
        reconnectAttempt: 0,
      },
      scroll,
    } as unknown as TerminalRenderTarget);

  const emitAppState = async (state: string) => {
    await act(async () => {
      mockAppState.currentState = state;
      for (const listener of mockAppState.listeners) listener(state);
      await Promise.resolve();
    });
  };

  const sendRendererMessage = async (
    webView: ReactTestInstance,
    message: Record<string, unknown>,
  ) => {
    await act(async () => {
      await webView.props.onMessage({
        nativeEvent: { data: JSON.stringify(message) },
      });
      await Promise.resolve();
    });
  };

  const mountReadyHost = async (
    activeTarget: TerminalRenderTarget,
    targets: TerminalRenderTarget[] = [activeTarget],
    previewTarget?: TerminalRenderTarget,
  ) => {
    const eventCallbacks = createCallbacks();
    const injected: string[] = [];
    await act(async () => {
      renderer = create(
        <TerminalRendererHost
          {...eventCallbacks}
          activeTarget={activeTarget}
          previewTarget={previewTarget}
          preferences={{ ...preferences, pauseResizeInBackground: true }}
          targets={targets}
          visible
        />,
        {
          createNodeMock: element =>
            element.type === 'WebView'
              ? {
                  injectJavaScript: (script: string) => injected.push(script),
                  requestFocus: jest.fn(),
                }
              : null,
        },
      );
    });
    const webView = renderer.root.find(
      node => typeof node.props.onMessage === 'function',
    );
    await sendRendererMessage(webView, { type: 'ready' });
    for (const target of targets) {
      if (target !== activeTarget && target !== previewTarget) continue;
      await sendRendererMessage(webView, {
        type: 'terminal-ready',
        key: target.key,
      });
      await sendRendererMessage(webView, {
        type: 'resize',
        source: 'fit',
        key: target.key,
        cols: 80,
        rows: 24,
        cellWidthPx: 8,
        cellHeightPx: 16,
      });
    }
    return { eventCallbacks, injected, webView };
  };

  test('closes the native bridge when a terminal target is removed', () => {
    const closeTerminalBridge = jest.fn(async () => undefined);
    const detachTerminal = jest.fn(async () => undefined);
    const isTerminalBridgeRetained = jest.fn(() => false);
    const client = {
      terminal: {
        closeTerminalBridge,
        detachTerminal,
        isTerminalBridgeRetained,
      },
      closeTerminalBridge,
      detachTerminal,
      isTerminalBridgeRetained,
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
    const closeTerminalBridge = jest.fn(async () => undefined);
    const detachTerminal = jest.fn(async () => undefined);
    const isTerminalBridgeRetained = jest.fn(() => false);
    const client = {
      terminal: {
        closeTerminalBridge,
        detachTerminal,
        isTerminalBridgeRetained,
      },
      closeTerminalBridge,
      detachTerminal,
      isTerminalBridgeRetained,
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
      scroll: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 100,
        viewport_rows: 24,
      },
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
          createNodeMock: element =>
            element.type === 'WebView'
              ? {
                  injectJavaScript: (script: string) => injected.push(script),
                  requestFocus: jest.fn(),
                }
              : null,
        },
      );
    });
    const webView = renderer.root.find(
      node => typeof node.props.onMessage === 'function',
    );
    await act(async () => {
      await webView.props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: 'ready' }) },
      });
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

  test('live frames make lifecycle transitions persist the renderer cache', async () => {
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 0,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, {
      offset_from_bottom: 0,
      max_offset_from_bottom: 0,
      viewport_rows: 24,
    });
    const { injected } = await mountReadyHost(target);
    injected.length = 0;

    act(() => {
      client.emitFrame({
        type: 'terminal.frame',
        seq: 1,
        encoding: 'utf8',
        width: 80,
        height: 24,
        full: true,
        bytes: 'live output',
      });
    });
    expect(injected.join('\n')).toContain('window.herdrWrite');

    injected.length = 0;
    await emitAppState('background');
    expect(injected.join('\n')).toContain('window.herdrSnapshot');
    expect(injected.join('\n')).toContain('background');
    expect(client.snapshot).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'restores the prior offset without new output',
      checkpoint: {
        offset_from_bottom: 200,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      current: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      expected: ['up', 200] as const,
    },
    {
      name: 'adds background scrollback growth to the prior offset',
      checkpoint: {
        offset_from_bottom: 200,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      current: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_050,
        viewport_rows: 24,
      },
      expected: ['up', 250] as const,
    },
    {
      name: 'keeps following latest output',
      checkpoint: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      current: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_100,
        viewport_rows: 24,
      },
      expected: null,
    },
    {
      name: 'clamps the prior offset when scrollback shrinks',
      checkpoint: {
        offset_from_bottom: 500,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      current: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 300,
        viewport_rows: 24,
      },
      expected: ['up', 300] as const,
    },
  ])(
    '$name after reconnect and final fit',
    async ({ checkpoint, current, expected }) => {
      const client = createClient({ 'term-1': current });
      const target = createTarget('term-1', client, checkpoint);
      const { webView } = await mountReadyHost(target);

      await emitAppState('background');
      await emitAppState('active');
      expect(client.snapshot).not.toHaveBeenCalled();
      expect(client.scrollTerminal).not.toHaveBeenCalled();
      await sendRendererMessage(webView, {
        type: 'resize',
        source: 'fit',
        key: target.key,
        cols: 80,
        rows: 24,
        cellWidthPx: 8,
        cellHeightPx: 16,
      });

      expect(client.releaseTerminal).toHaveBeenCalledWith(
        'term-1',
        expect.objectContaining({ testAttachmentId: 1 }),
      );
      expect(client.snapshot).toHaveBeenCalledTimes(1);
      expect(client.releaseTerminal.mock.invocationCallOrder[0]).toBeLessThan(
        client.openTerminal.mock.invocationCallOrder.at(-1)!,
      );
      if (expected) {
        expect(client.scrollTerminal).toHaveBeenCalledWith(
          'term-1',
          ...expected,
        );
        expect(
          client.resizeTerminal.mock.invocationCallOrder.at(-1),
        ).toBeLessThan(client.scrollTerminal.mock.invocationCallOrder[0]);
      } else {
        expect(client.scrollTerminal).not.toHaveBeenCalled();
      }
    },
  );

  test('in-app visibility changes do not enter the resume restore path', async () => {
    const checkpoint = {
      offset_from_bottom: 200,
      max_offset_from_bottom: 1_000,
      viewport_rows: 24,
    };
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, checkpoint);
    const eventCallbacks = createCallbacks();
    await mountReadyHost(target);

    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...eventCallbacks}
          activeTarget={target}
          preferences={{ ...preferences, pauseResizeInBackground: true }}
          targets={[target]}
          visible={false}
        />,
      );
    });
    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...eventCallbacks}
          activeTarget={target}
          preferences={{ ...preferences, pauseResizeInBackground: true }}
          targets={[target]}
          visible
        />,
      );
    });

    expect(client.releaseTerminal).not.toHaveBeenCalled();
    expect(client.snapshot).not.toHaveBeenCalled();
    expect(client.scrollTerminal).not.toHaveBeenCalled();
  });

  test('an old renderer unmount cannot detach a replacement renderer controller', async () => {
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 0,
        viewport_rows: 24,
      },
    });
    let owner: object | null = null;
    client.openTerminal.mockImplementation(async () => {
      owner = {};
      return owner as { testAttachmentId: number };
    });
    client.detachTerminal.mockImplementation(
      async (_terminalId, attachmentId) => {
        if (owner === attachmentId) owner = null;
      },
    );
    const target = createTarget('term-1', client, {
      offset_from_bottom: 0,
      max_offset_from_bottom: 0,
      viewport_rows: 24,
    });
    const mount = async (): Promise<ReactTestRenderer> => {
      let host!: ReactTestRenderer;
      act(() => {
        host = create(
          <TerminalRendererHost
            {...createCallbacks()}
            activeTarget={target}
            preferences={preferences}
            targets={[target]}
            visible
          />,
          {
            createNodeMock: element =>
              element.type === 'WebView'
                ? {
                    injectJavaScript: jest.fn(),
                    requestFocus: jest.fn(),
                  }
                : null,
          },
        );
      });
      const webView = host.root.find(
        node => typeof node.props.onMessage === 'function',
      );
      await sendRendererMessage(webView, { type: 'ready' });
      await sendRendererMessage(webView, {
        type: 'terminal-ready',
        key: target.key,
      });
      await sendRendererMessage(webView, {
        type: 'resize',
        source: 'fit',
        key: target.key,
        cols: 80,
        rows: 24,
        cellWidthPx: 8,
        cellHeightPx: 16,
      });
      return host;
    };

    const oldRenderer = await mount();
    const oldOwner = owner;
    renderer = await mount();
    const replacementOwner = owner;
    expect(replacementOwner).not.toBe(oldOwner);

    await act(async () => {
      oldRenderer.unmount();
      await Promise.resolve();
    });

    expect(client.detachTerminal).toHaveBeenCalledWith('term-1', oldOwner);
    expect(owner).toBe(replacementOwner);
  });

  test('explicit user scrolling cancels a pending resume restore', async () => {
    const checkpoint = {
      offset_from_bottom: 200,
      max_offset_from_bottom: 1_000,
      viewport_rows: 24,
    };
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, checkpoint);
    const { webView } = await mountReadyHost(target);

    await emitAppState('background');
    await emitAppState('active');
    await sendRendererMessage(webView, {
      type: 'scroll',
      key: target.key,
      direction: 'up',
      lines: 3,
    });
    await sendRendererMessage(webView, {
      type: 'resize',
      source: 'fit',
      key: target.key,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });

    expect(client.snapshot).not.toHaveBeenCalled();
    expect(client.scrollTerminal).toHaveBeenCalledTimes(1);
    expect(client.scrollTerminal).toHaveBeenCalledWith(
      'term-1',
      'up',
      3,
      undefined,
      undefined,
    );
  });

  test('alternate-screen activation cancels normal-buffer resume restoration', async () => {
    const checkpoint = {
      offset_from_bottom: 200,
      max_offset_from_bottom: 1_000,
      viewport_rows: 24,
    };
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, checkpoint);
    const { webView } = await mountReadyHost(target);

    await emitAppState('background');
    await emitAppState('active');
    await sendRendererMessage(webView, {
      type: 'buffer-mode',
      key: target.key,
      alternate: true,
    });
    await sendRendererMessage(webView, {
      type: 'resize',
      source: 'fit',
      key: target.key,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });

    expect(client.snapshot).not.toHaveBeenCalled();
    expect(client.scrollTerminal).not.toHaveBeenCalled();
  });

  test('restores checkpoints only onto their matching terminal keys', async () => {
    const firstScroll = {
      offset_from_bottom: 100,
      max_offset_from_bottom: 1_000,
      viewport_rows: 24,
    };
    const secondScroll = {
      offset_from_bottom: 300,
      max_offset_from_bottom: 2_000,
      viewport_rows: 24,
    };
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_020,
        viewport_rows: 24,
      },
      'term-2': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 2_040,
        viewport_rows: 24,
      },
    });
    const first = createTarget('term-1', client, firstScroll);
    const second = createTarget('term-2', client, secondScroll);
    const { webView } = await mountReadyHost(first, [first, second], second);

    await emitAppState('background');
    await emitAppState('active');
    await sendRendererMessage(webView, {
      type: 'resize',
      source: 'fit',
      key: first.key,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });

    expect(client.scrollTerminal).toHaveBeenCalledWith('term-1', 'up', 120);
    expect(client.scrollTerminal).toHaveBeenCalledWith('term-2', 'up', 340);
  });
});
