import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  Animated,
  AppState,
  Clipboard,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import WebView from 'react-native-webview/lib/WebView.android';
import type { WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';

import type { TerminalFrame } from '../lib/terminalBridge';
import type { TerminalRenderTarget } from '../lib/terminalRenderer';
import type { TerminalPreferences } from '../services/devicePreferences';
import type { TerminalSessionStatus } from '../terminalSessions';
import { terminalHtml } from '../generated/terminalHtml';

const MAX_RECONNECT_ATTEMPTS = 5;
const FRAME_CHUNK_SIZE = 16_384;
const WEBVIEW_CONTAINER_STYLE = { backgroundColor: 'transparent' } as const;

interface WebViewHandle {
  injectJavaScript: (script: string) => void;
}

interface RendererEntry {
  target: TerminalRenderTarget;
  rendererReady: boolean;
  controllerAttached: boolean;
  connecting: boolean;
  pendingFrames: TerminalFrame[];
  resetOnNextFrame: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  fontPreference: number;
  fontSize: number;
}

export interface TerminalRendererHandle {
  blur: () => void;
  clearSearch: () => void;
  fit: () => void;
  focus: () => void;
  paste: (data: string) => void;
  retry: () => void;
  scanLinks: () => void;
  search: (query: string, caseSensitive: boolean, regex: boolean, direction: number) => void;
  setKeyboardEnabled: (enabled: boolean) => void;
  submit: (data: string) => void;
}

interface Props {
  activeTarget: TerminalRenderTarget | null;
  previewTarget?: TerminalRenderTarget | null;
  targets: readonly TerminalRenderTarget[];
  visible: boolean;
  preferences: TerminalPreferences;
  swipe?: {
    direction: -1 | 1;
    offset: Animated.Value;
  } | null;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onInput: (target: TerminalRenderTarget, data: string) => void | Promise<void>;
  onScroll: (target: TerminalRenderTarget, direction: 'up' | 'down', lines: number) => void;
  onFontSizeChange: (target: TerminalRenderTarget, fontSize: number) => void;
  onSearchResult: (count: number, index: number, invalid: boolean) => void;
  onLinksScanned: (links: string[]) => void;
  onOpenLink: (link: string) => void;
  onStatus: (
    target: TerminalRenderTarget,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => void;
  onError: (target: TerminalRenderTarget, error: string) => void;
}

export const TerminalRendererHost = forwardRef<TerminalRendererHandle, Props>(function TerminalRendererHostComponent({
  activeTarget,
  previewTarget,
  targets,
  visible,
  preferences,
  swipe,
  style,
  onReady,
  onInput,
  onScroll,
  onFontSizeChange,
  onSearchResult,
  onLinksScanned,
  onOpenLink,
  onStatus,
  onError,
}, forwardedRef) {
  const webView = useRef<WebViewHandle | null>(null);
  const hostReady = useRef(false);
  const entries = useRef(new Map<string, RendererEntry>());
  const activeKey = useRef<string | null>(null);
  activeKey.current = activeTarget?.key || null;

  const reportReady = useEffectEvent(() => onReady?.());
  const reportInput = useEffectEvent(onInput);
  const reportScroll = useEffectEvent(onScroll);
  const reportFontSize = useEffectEvent(onFontSizeChange);
  const reportSearch = useEffectEvent(onSearchResult);
  const reportLinks = useEffectEvent(onLinksScanned);
  const reportOpenLink = useEffectEvent(onOpenLink);
  const reportStatus = useEffectEvent(onStatus);
  const reportError = useEffectEvent(onError);

  const inject = useCallback((script: string) => {
    webView.current?.injectJavaScript(`${script} true;`);
  }, []);

  const configureEntry = useCallback((entry: RendererEntry) => {
    inject(`window.herdrConfigure(${JSON.stringify(entry.target.key)}, ${JSON.stringify({
      ...preferences,
      fontSize: entry.fontSize,
      backgroundImageUri: null,
    })});`);
  }, [inject, preferences]);

  const injectFrame = useCallback((entry: RendererEntry, frame: TerminalFrame) => {
    if (!hostReady.current || !entry.rendererReady) {
      entry.pendingFrames.push(frame);
      return;
    }
    const key = JSON.stringify(entry.target.key);
    const reset = entry.resetOnNextFrame;
    if (reset) entry.resetOnNextFrame = false;
    const resetScript = reset ? `window.herdrReset(${key}); ` : '';
    if (typeof frame.final === 'boolean') {
      inject(`${resetScript}window.herdrWriteBase64Chunk(${key}, ${frame.seq}, ${JSON.stringify(frame.bytes)}, ${frame.final});`);
      return;
    }
    for (let offset = 0; offset < frame.bytes.length; offset += FRAME_CHUNK_SIZE) {
      const chunk = frame.bytes.slice(offset, offset + FRAME_CHUNK_SIZE);
      const final = offset + FRAME_CHUNK_SIZE >= frame.bytes.length;
      inject(`${offset === 0 ? resetScript : ''}window.herdrWriteBase64Chunk(${key}, ${frame.seq}, ${JSON.stringify(chunk)}, ${final});`);
    }
  }, [inject]);

  const connectEntry = useCallback((entry: RendererEntry) => {
    if (entry.connecting || entry.controllerAttached) return;
    entry.connecting = true;
    entry.controllerAttached = true;
    const { client, session } = entry.target;
    const terminalId = session.terminalId;
    const retained = client.isTerminalBridgeRetained(terminalId);
    if (!retained) {
      entry.resetOnNextFrame = true;
      entry.pendingFrames = [];
      reportStatus(entry.target, 'connecting', undefined, entry.reconnectAttempt);
    }
    const scheduleReconnect = (reason: string) => {
      entry.connecting = false;
      entry.controllerAttached = false;
      if (AppState.currentState !== 'active') return;
      const nextAttempt = entry.reconnectAttempt + 1;
      if (nextAttempt > MAX_RECONNECT_ATTEMPTS) {
        reportStatus(entry.target, 'error', reason, entry.reconnectAttempt);
        return;
      }
      entry.reconnectAttempt = nextAttempt;
      reportStatus(entry.target, 'disconnected', reason, nextAttempt);
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = setTimeout(
        () => connectEntry(entry),
        Math.min(8000, 750 * (2 ** (nextAttempt - 1))),
      );
    };
    client.openTerminal(
      terminalId,
      frame => injectFrame(entry, frame),
      reason => scheduleReconnect(reason || 'Remote terminal closed'),
    ).then(() => {
      entry.connecting = false;
      entry.reconnectAttempt = 0;
      reportStatus(entry.target, 'connected', undefined, 0);
    }).catch(reason => {
      const message = String(reason);
      entry.connecting = false;
      entry.controllerAttached = false;
      reportError(entry.target, message);
      scheduleReconnect(message);
    });
  }, [injectFrame]);

  const ensureEntry = useCallback((target: TerminalRenderTarget | null | undefined): RendererEntry | null => {
    if (!target) return null;
    let entry = entries.current.get(target.key);
    if (!entry) {
      entry = {
        target,
        rendererReady: false,
        controllerAttached: false,
        connecting: false,
        pendingFrames: [],
        resetOnNextFrame: true,
        reconnectAttempt: target.session.reconnectAttempt || 0,
        reconnectTimer: null,
        fontPreference: preferences.fontSize,
        fontSize: preferences.fontSize,
      };
      entries.current.set(target.key, entry);
      if (hostReady.current) {
        inject(`window.herdrCreate(${JSON.stringify(target.key)});`);
        configureEntry(entry);
      }
    } else {
      entry.target = target;
    }
    connectEntry(entry);
    return entry;
  }, [configureEntry, connectEntry, inject, preferences.fontSize]);

  const activeCall = useCallback((method: string, args: unknown[] = []) => {
    const key = activeKey.current;
    if (!key) return;
    inject(`window.${method}(${[JSON.stringify(key), ...args.map(value => JSON.stringify(value))].join(', ')});`);
  }, [inject]);

  useImperativeHandle(forwardedRef, () => ({
    blur: () => activeCall('herdrBlur'),
    clearSearch: () => activeCall('herdrClearSearch'),
    fit: () => activeCall('herdrFit'),
    focus: () => activeCall('herdrFocus'),
    paste: data => activeCall('herdrPaste', [data]),
    retry: () => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (!entry) return;
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
      entry.controllerAttached = false;
      entry.connecting = false;
      entry.reconnectAttempt = 0;
      entry.target.client.closeTerminal(entry.target.session.terminalId);
      reportStatus(entry.target, 'connecting', undefined, 0);
      connectEntry(entry);
    },
    scanLinks: () => activeCall('herdrScanLinks'),
    search: (query, caseSensitive, regex, direction) => activeCall(
      'herdrSearch',
      [query, caseSensitive, regex, direction],
    ),
    setKeyboardEnabled: enabled => activeCall('herdrSetKeyboardEnabled', [enabled]),
    submit: data => activeCall('herdrSubmit', [data]),
  }), [activeCall, connectEntry]);

  useEffect(() => {
    const valid = new Map(targets.map(target => [target.key, target]));
    for (const target of targets) ensureEntry(target);
    for (const [key, entry] of entries.current) {
      const target = valid.get(key);
      if (target) {
        entry.target = target;
        continue;
      }
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      entry.target.client.closeTerminalBridge(entry.target.session.terminalId).catch(() => undefined);
      entries.current.delete(key);
      if (hostReady.current) inject(`window.herdrRemove(${JSON.stringify(key)});`);
    }
  }, [ensureEntry, inject, targets]);

  useEffect(() => {
    for (const entry of entries.current.values()) {
      if (entry.fontPreference !== preferences.fontSize) {
        entry.fontPreference = preferences.fontSize;
        entry.fontSize = preferences.fontSize;
      }
      if (hostReady.current) configureEntry(entry);
    }
  }, [configureEntry, preferences]);

  useEffect(() => {
    if (!hostReady.current) return;
    if (!visible || !activeTarget) {
      if (activeTarget) inject(`window.herdrBlur(${JSON.stringify(activeTarget.key)});`);
      return;
    }
    if (!swipe || !previewTarget) {
      inject(`window.herdrActivate(${JSON.stringify(activeTarget.key)});`);
      return;
    }
    const update = ({ value }: { value: number }) => {
      inject(`window.herdrSwipe(${JSON.stringify(activeTarget.key)}, ${JSON.stringify(previewTarget.key)}, ${swipe.direction}, ${value});`);
    };
    const listener = swipe.offset.addListener(update);
    swipe.offset.stopAnimation(value => update({ value }));
    return () => {
      swipe.offset.removeListener(listener);
      inject(`window.herdrActivate(${JSON.stringify(activeKey.current)});`);
    };
  }, [activeTarget, inject, previewTarget, swipe, visible]);

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const wasActive = previous === 'active';
      previous = state;
      if (state !== 'active' || wasActive) return;
      for (const entry of entries.current.values()) {
        if (!entry.target.client.isTerminalBridgeRetained(entry.target.session.terminalId)) {
          entry.controllerAttached = false;
          entry.connecting = false;
          entry.reconnectAttempt = 0;
          connectEntry(entry);
        }
      }
    });
    return () => subscription.remove();
  }, [connectEntry]);

  useEffect(() => () => {
    for (const entry of entries.current.values()) {
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      entry.target.client.detachTerminal(entry.target.session.terminalId).catch(() => undefined);
    }
    entries.current.clear();
  }, []);

  const handleMessage = async (event: WebViewMessageEvent) => {
    const message = JSON.parse(event.nativeEvent.data);
    if (message.type === 'ready') {
      hostReady.current = true;
      for (const entry of entries.current.values()) {
        inject(`window.herdrCreate(${JSON.stringify(entry.target.key)});`);
        configureEntry(entry);
      }
      if (visible && activeKey.current) {
        inject(`window.herdrActivate(${JSON.stringify(activeKey.current)});`);
      }
      reportReady();
      return;
    }
    const entry = typeof message.key === 'string' ? entries.current.get(message.key) : null;
    if (!entry) return;
    if (message.type === 'terminal-ready') {
      entry.rendererReady = true;
      const frames = entry.pendingFrames;
      entry.pendingFrames = [];
      for (const frame of frames) injectFrame(entry, frame);
      return;
    }
    if (message.type === 'input') {
      await reportInput(entry.target, message.data);
    } else if (message.type === 'buffered-submit') {
      try {
        await entry.target.client.writeToTerminal(entry.target.session.terminalId, message.data);
      } catch (reason) {
        reportError(entry.target, String(reason));
      }
    } else if (message.type === 'resize') {
      entry.target.client.resizeTerminal(
        entry.target.session.terminalId,
        message.cols,
        message.rows,
        message.cellWidthPx,
        message.cellHeightPx,
      );
    } else if (message.type === 'scroll') {
      reportScroll(entry.target, message.direction, message.lines);
      try {
        await entry.target.client.scrollTerminal(
          entry.target.session.terminalId,
          message.direction,
          message.lines,
        );
      } catch (reason) {
        reportError(entry.target, String(reason));
      }
    } else if (message.type === 'font-size-change') {
      const fontSize = Number(message.fontSize);
      if (Number.isFinite(fontSize)) {
        entry.fontSize = Math.max(8, Math.min(24, Math.round(fontSize)));
        reportFontSize(entry.target, entry.fontSize);
      }
    } else if (message.type === 'clipboard-write') {
      Clipboard.setString(message.text || '');
    } else if (message.type === 'clipboard-read') {
      const value = await Clipboard.getString();
      if (value) inject(`window.herdrPaste(${JSON.stringify(entry.target.key)}, ${JSON.stringify(value)});`);
    } else if (entry.target.key === activeKey.current && message.type === 'search-result') {
      reportSearch(message.count, message.index, Boolean(message.invalid));
    } else if (entry.target.key === activeKey.current && message.type === 'link-scan-result') {
      reportLinks(Array.isArray(message.links)
        ? message.links.filter((link: unknown) => typeof link === 'string')
        : []);
    } else if (
      entry.target.key === activeKey.current
      && message.type === 'open-link'
      && typeof message.link === 'string'
    ) {
      reportOpenLink(message.link);
    }
  };

  return (
    <WebView
      ref={value => {
        webView.current = value as WebViewHandle | null;
      }}
      source={{ html: terminalHtml, baseUrl: 'file:///android_asset/' }}
      originWhitelist={['file://*', 'about:blank']}
      allowFileAccess
      javaScriptEnabled
      textZoom={100}
      onMessage={handleMessage}
      style={style}
      containerStyle={WEBVIEW_CONTAINER_STYLE}
    />
  );
});
