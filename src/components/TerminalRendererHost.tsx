import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  AppState,
  Clipboard,
  Platform,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import WebView from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';

import type { TerminalFrame, TerminalProtocolState } from '../lib/terminalBridge';
import { arrayBufferToBase64 } from '../lib/base64';
import {
  isOfflineTerminalNavigationInput,
  terminalScrollbackMode,
  type TerminalRenderTarget,
} from '../lib/terminalRenderer';
import { prepareTerminalPaste } from '../lib/terminalPaste';
import { terminalSubmissionWrites } from '../lib/terminalSubmission';
import {
  terminalRendererEvictionKeys,
  touchTerminalRendererEntry,
} from '../lib/terminalRendererLru';
import type { TerminalPreferences } from '../services/devicePreferences';
import { networkErrorMessage, recordNetworkDiagnostic } from '../services/networkDiagnostics';
import {
  beginTerminalInputTrace,
  endTerminalWriteTrace,
  terminalFrameReceived,
  terminalFrameRendered,
} from '../services/performanceTrace';
import { IOS_TERMINAL_ASSETS } from '../services/terminalAssets';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { PaneScrollInfo } from '../types';

const MAX_RECONNECT_ATTEMPTS = 5;
const FRAME_CHUNK_SIZE = 16_384;
const TRANSCRIPT_CHUNK_SIZE = 16_384;
const WEBVIEW_CONTAINER_STYLE = { backgroundColor: 'transparent' } as const;
const IOS_TERMINAL_ASSET_DIRECTORY = IOS_TERMINAL_ASSETS?.directoryURL || '';
const TERMINAL_SOURCE = Platform.select({
  android: { uri: 'file:///android_asset/herdr-terminal.html' },
  ios: { uri: IOS_TERMINAL_ASSETS?.indexURL || 'about:blank' },
  default: { uri: 'about:blank' },
});

interface WebViewHandle {
  injectJavaScript: (script: string) => void;
  requestFocus: () => void;
}

interface RendererEntry {
  target: TerminalRenderTarget;
  rendererReady: boolean;
  sizeReady: boolean;
  controllerAttached: boolean;
  connecting: boolean;
  pendingFrames: Array<{ frame: TerminalFrame; traceCookie: number | null }>;
  resetOnNextFrame: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  fontPreference: number;
  fontSize: number;
  protocolState: TerminalProtocolState;
  inputTail: Promise<void>;
}

export interface TerminalRendererHandle {
  blur: () => void;
  changeFontSize: (delta: -1 | 1) => void;
  clearSearch: () => void;
  fit: () => void;
  focus: () => void;
  input: (data: string) => boolean;
  paste: (data: string) => void;
  retry: () => void;
  scanLinks: () => void;
  scroll: (direction: 'up' | 'down', lines: number) => void;
  search: (query: string, caseSensitive: boolean, regex: boolean, direction: number) => void;
  setKeyboardEnabled: (enabled: boolean) => void;
  submitPastes: (target: TerminalRenderTarget, parts: readonly string[]) => Promise<void>;
}

interface Props {
  activeTarget: TerminalRenderTarget | null;
  previewTarget?: TerminalRenderTarget | null;
  targets: readonly TerminalRenderTarget[];
  visible: boolean;
  preferences: TerminalPreferences;
  offlineTranscript?: string;
  offlineScroll?: PaneScrollInfo;
  swipe?: {
    direction: -1 | 1;
    offset: SharedValue<number>;
  } | null;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onInput: (target: TerminalRenderTarget, data: string) => void | Promise<void>;
  onScroll: (target: TerminalRenderTarget, direction: 'up' | 'down', lines: number) => void;
  onOfflineScroll: (target: TerminalRenderTarget, scroll: PaneScrollInfo) => void;
  onSearchResult: (count: number, index: number, invalid: boolean) => void;
  onLinksScanned: (links: string[]) => void;
  onOpenLink: (link: string) => void;
  onPaste: (target: TerminalRenderTarget, text: string) => void;
  onBufferModeChange: (target: TerminalRenderTarget, alternate: boolean) => void;
  onProtocolStateChange: (target: TerminalRenderTarget, state: TerminalProtocolState) => void;
  onTitleChange: (target: TerminalRenderTarget, title: string) => void;
  onFontSizeChange: (target: TerminalRenderTarget, fontSize: number) => void;
  onSelectionStateChange: (target: TerminalRenderTarget, active: boolean) => void;
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
  offlineTranscript = '',
  offlineScroll,
  swipe,
  style,
  onReady,
  onInput,
  onScroll,
  onOfflineScroll,
  onSearchResult,
  onLinksScanned,
  onOpenLink,
  onPaste,
  onBufferModeChange,
  onProtocolStateChange,
  onTitleChange,
  onFontSizeChange,
  onSelectionStateChange,
  onStatus,
  onError,
}, forwardedRef) {
  const webView = useRef<WebViewHandle | null>(null);
  const hostReady = useRef(false);
  const entries = useRef(new Map<string, RendererEntry>());
  const knownTargets = useRef(new Map<string, TerminalRenderTarget>());
  const activeKey = useRef<string | null>(null);
  const appState = useRef(AppState.currentState);
  const offlineTranscriptRef = useRef(offlineTranscript);
  const offlineScrollRef = useRef(offlineScroll);
  activeKey.current = activeTarget?.key || null;
  offlineTranscriptRef.current = offlineTranscript;
  offlineScrollRef.current = offlineScroll;

  const reportReady = useEffectEvent(() => onReady?.());
  const reportInput = useEffectEvent(onInput);
  const reportScroll = useEffectEvent(onScroll);
  const reportOfflineScroll = useEffectEvent(onOfflineScroll);
  const reportSearch = useEffectEvent(onSearchResult);
  const reportLinks = useEffectEvent(onLinksScanned);
  const reportOpenLink = useEffectEvent(onOpenLink);
  const reportPaste = useEffectEvent(onPaste);
  const reportBufferMode = useEffectEvent(onBufferModeChange);
  const reportProtocolState = useEffectEvent(onProtocolStateChange);
  const reportTitle = useEffectEvent(onTitleChange);
  const reportFontSize = useEffectEvent(onFontSizeChange);
  const reportSelectionState = useEffectEvent(onSelectionStateChange);
  const reportStatus = useEffectEvent(onStatus);
  const reportError = useEffectEvent(onError);

  const inject = useCallback((script: string) => {
    webView.current?.injectJavaScript(`${script} true;`);
  }, []);

  const disposeEntry = useCallback((
    key: string,
    entry: RendererEntry,
    closeBridge: boolean,
  ) => {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
    entry.controllerAttached = false;
    entry.connecting = false;
    entries.current.delete(key);
    const terminalId = entry.target.session.terminalId;
    if (closeBridge) {
      entry.target.client.closeTerminalBridge(terminalId).catch(() => undefined);
    } else {
      entry.target.client.detachTerminal(terminalId).catch(() => undefined);
    }
    if (hostReady.current) inject(`window.herdrRemove(${JSON.stringify(key)});`);
  }, [inject]);

  const pruneEntries = useCallback((protectedKeys: ReadonlySet<string>) => {
    const evictions = terminalRendererEvictionKeys(
      [...entries.current.keys()],
      preferences.xtermCacheCapacity,
      protectedKeys,
    );
    for (const key of evictions) {
      const entry = entries.current.get(key);
      if (entry) disposeEntry(key, entry, false);
    }
  }, [disposeEntry, preferences.xtermCacheCapacity]);

  const configureEntry = useCallback((entry: RendererEntry) => {
    const scrollbackMode = terminalScrollbackMode(entry.target.session);
    inject(`window.herdrConfigure(${JSON.stringify(entry.target.key)}, ${JSON.stringify({
      ...preferences,
      fontSize: entry.fontSize,
      backgroundImageUri: null,
      ...scrollbackMode,
    })});`);
  }, [inject, preferences]);

  const syncOfflineTranscript = useCallback((
    targetKey: string,
    targetKind: TerminalRenderTarget['session']['kind'],
    offlineScrollback: boolean,
    transcript: string,
    scroll?: PaneScrollInfo,
  ) => {
    const key = JSON.stringify(targetKey);
    if (
      targetKind === 'ssh'
      || !offlineScrollback
      || !transcript
    ) {
      inject(`window.herdrHideOfflineTranscript(${key});`);
      return;
    }
    inject(`window.herdrBeginOfflineTranscript(${key});`);
    for (let offset = 0; offset < transcript.length; offset += TRANSCRIPT_CHUNK_SIZE) {
      inject(`window.herdrAppendOfflineTranscript(${key}, ${JSON.stringify(
        transcript.slice(offset, offset + TRANSCRIPT_CHUNK_SIZE),
      )});`);
    }
    inject(`window.herdrCommitOfflineTranscript(${key}, ${scroll?.offset_from_bottom || 0});`);
  }, [inject]);

  const injectFrame = useCallback((
    entry: RendererEntry,
    frame: TerminalFrame,
    traceCookie: number | null = terminalFrameReceived(entry.target.key),
  ) => {
    if (!hostReady.current || !entry.rendererReady) {
      entry.pendingFrames.push({ frame, traceCookie });
      return;
    }
    const key = JSON.stringify(entry.target.key);
    const serializedTraceCookie = traceCookie === null ? 'null' : String(traceCookie);
    const reset = entry.resetOnNextFrame;
    if (reset) entry.resetOnNextFrame = false;
    const resetScript = reset ? `window.herdrReset(${key}); ` : '';
    if (frame.encoding === 'utf8') {
      if (typeof frame.bytes !== 'string') return;
      inject(`${resetScript}window.herdrWrite(${key}, ${JSON.stringify(frame.bytes)}, ${serializedTraceCookie});`);
      return;
    }
    if (typeof frame.bytes === 'string' && typeof frame.final === 'boolean') {
      inject(`${resetScript}window.herdrWriteBase64Chunk(${key}, ${frame.seq}, ${JSON.stringify(frame.bytes)}, ${frame.final}, ${serializedTraceCookie});`);
      return;
    }
    const encoded = typeof frame.bytes === 'string'
      ? frame.bytes
      : arrayBufferToBase64(frame.bytes);
    const writes: string[] = [];
    if (encoded.length === 0) {
      writes.push(`window.herdrWriteBase64Chunk(${key}, ${frame.seq}, "", true, ${serializedTraceCookie});`);
    } else {
      for (let offset = 0; offset < encoded.length; offset += FRAME_CHUNK_SIZE) {
        const chunk = encoded.slice(offset, offset + FRAME_CHUNK_SIZE);
        const final = offset + FRAME_CHUNK_SIZE >= encoded.length;
        const finalTraceCookie = final ? `, ${serializedTraceCookie}` : '';
        writes.push(`window.herdrWriteBase64Chunk(${key}, ${frame.seq}, ${JSON.stringify(chunk)}, ${final}${finalTraceCookie});`);
      }
    }
    // A frame can require multiple chunks, but it crosses into the WebView once.
    inject(`${resetScript}${writes.join('')}`);
  }, [inject]);

  const connectEntry = useCallback((entry: RendererEntry, showConnecting = true) => {
    if (preferences.pauseResizeInBackground && appState.current !== 'active') return;
    // Opening the remote terminal before xterm has measured the WebView starts
    // it at HerdrClient's 80x24 fallback and immediately sends a second resize.
    // Wait for the configured renderer's first measured size instead.
    if (!entry.rendererReady || !entry.sizeReady) return;
    if (entry.connecting || entry.controllerAttached) return;
    entry.connecting = true;
    entry.controllerAttached = true;
    const { client, session } = entry.target;
    const terminalId = session.terminalId;
    const retained = client.isTerminalBridgeRetained(terminalId);
    if (!retained) {
      entry.resetOnNextFrame = true;
      entry.pendingFrames = [];
      if (showConnecting) {
        reportStatus(entry.target, 'connecting', undefined, entry.reconnectAttempt);
      }
    }
    const scheduleReconnect = (reason: string) => {
      if (entries.current.get(entry.target.key) !== entry) return;
      entry.connecting = false;
      entry.controllerAttached = false;
      if (AppState.currentState !== 'active') return;
      const nextAttempt = entry.reconnectAttempt + 1;
      if (nextAttempt > MAX_RECONNECT_ATTEMPTS) {
        recordNetworkDiagnostic('error', 'terminal-reconnect-exhausted', {
          sessionId: entry.target.hostSessionId,
          terminalId,
          attempts: entry.reconnectAttempt,
          reason: networkErrorMessage(reason),
        });
        reportStatus(entry.target, 'error', reason, entry.reconnectAttempt);
        return;
      }
      entry.reconnectAttempt = nextAttempt;
      const delayMs = Math.min(8000, 750 * (2 ** (nextAttempt - 1)));
      recordNetworkDiagnostic('warn', 'terminal-reconnect-scheduled', {
        sessionId: entry.target.hostSessionId,
        terminalId,
        attempt: nextAttempt,
        delayMs,
        reason: networkErrorMessage(reason),
      });
      reportStatus(entry.target, 'disconnected', reason, nextAttempt);
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = setTimeout(
        () => connectEntry(entry),
        delayMs,
      );
    };
    client.openTerminal(
      terminalId,
      frame => injectFrame(entry, frame),
      reason => scheduleReconnect(reason || 'Remote terminal closed'),
      event => {
        if (event.type === 'protocol-state') {
          entry.protocolState = event.state;
          reportProtocolState(entry.target, event.state);
        } else if (event.type === 'clipboard-write') {
          Clipboard.setString(event.text);
        } else if (event.type === 'title') {
          reportTitle(entry.target, event.title);
        }
      },
    ).then(() => {
      if (entries.current.get(entry.target.key) !== entry) return;
      const recoveryAttempt = entry.reconnectAttempt;
      entry.connecting = false;
      entry.reconnectAttempt = 0;
      reportStatus(entry.target, 'connected', undefined, 0);
      if (recoveryAttempt > 0) {
        recordNetworkDiagnostic('info', 'terminal-reconnect-recovered', {
          sessionId: entry.target.hostSessionId,
          terminalId,
          attempt: recoveryAttempt,
        });
      }
    }).catch(reason => {
      if (entries.current.get(entry.target.key) !== entry) return;
      const message = String(reason);
      entry.connecting = false;
      entry.controllerAttached = false;
      reportError(entry.target, message);
      scheduleReconnect(message);
    });
  }, [injectFrame, preferences.pauseResizeInBackground]);

  const ensureEntry = useCallback((target: TerminalRenderTarget | null | undefined): RendererEntry | null => {
    if (!target) return null;
    let entry = touchTerminalRendererEntry(entries.current, target.key);
    if (!entry) {
      entry = {
        target,
        rendererReady: false,
        sizeReady: false,
        controllerAttached: false,
        connecting: false,
        pendingFrames: [],
        resetOnNextFrame: true,
        reconnectAttempt: target.session.reconnectAttempt || 0,
        reconnectTimer: null,
        fontPreference: preferences.fontSize,
        fontSize: target.session.fontSize ?? preferences.fontSize,
        protocolState: {
          kittyKeyboardReportAll: false,
        },
        inputTail: Promise.resolve(),
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

  const enqueueInput = useCallback((
    entry: RendererEntry,
    operation: () => void | Promise<void>,
  ) => {
    const pending = entry.inputTail.then(operation, operation);
    entry.inputTail = pending.catch(() => undefined);
    return pending;
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    blur: () => activeCall('herdrBlur'),
    changeFontSize: delta => activeCall('herdrChangeFontSize', [delta]),
    clearSearch: () => activeCall('herdrClearSearch'),
    fit: () => activeCall('herdrFit'),
    focus: () => {
      webView.current?.requestFocus();
      activeCall('herdrFocus');
    },
    input: data => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (
        !entry
        || entry.target.session.status === 'connected'
        || !isOfflineTerminalNavigationInput(data)
      ) return false;
      activeCall('herdrOfflineInput', [data]);
      return true;
    },
    paste: data => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (!entry) return;
      if (entry.target.session.status !== 'connected') return;
      if (entry.target.session.kind === 'ssh') {
        activeCall('herdrPaste', [data]);
        return;
      }
      enqueueInput(entry, () => entry.target.client.pasteIntoPane(
        entry.target.session.paneId,
        prepareTerminalPaste(data),
      )).catch(reason => reportError(entry.target, String(reason)));
    },
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
      recordNetworkDiagnostic('info', 'terminal-manual-retry', {
        sessionId: entry.target.hostSessionId,
        terminalId: entry.target.session.terminalId,
      });
      reportStatus(entry.target, 'connecting', undefined, 0);
      connectEntry(entry);
    },
    scanLinks: () => activeCall('herdrScanLinks'),
    scroll: (direction, lines) => activeCall('herdrScroll', [direction, lines]),
    search: (query, caseSensitive, regex, direction) => activeCall(
      'herdrSearch',
      [query, caseSensitive, regex, direction],
    ),
    setKeyboardEnabled: enabled => {
      if (enabled) webView.current?.requestFocus();
      activeCall('herdrSetKeyboardEnabled', [enabled]);
    },
    submitPastes: (target, parts) => {
      const entry = ensureEntry(target);
      if (!entry) return Promise.reject(new Error('Terminal is not available'));
      if (entry.target.session.status !== 'connected') {
        return Promise.reject(new Error('Terminal is offline and read-only'));
      }
      if (entry.target.session.kind === 'ssh') {
        inject(`window.herdrSubmitPastes(${JSON.stringify(target.key)}, ${JSON.stringify(parts)});`);
        return Promise.resolve();
      }
      const prepared = parts.map(prepareTerminalPaste);
      const inputTrace = beginTerminalInputTrace(entry.target.key, 'submit');
      return enqueueInput(entry, () => {
        const submission = entry.target.client.submitPastesToPane(
          entry.target.session.paneId,
          prepared,
        );
        endTerminalWriteTrace(inputTrace, true);
        return submission;
      }).catch(reason => {
        endTerminalWriteTrace(inputTrace, false);
        reportError(entry.target, String(reason));
        throw reason;
      });
    },
  }), [activeCall, connectEntry, enqueueInput, ensureEntry, inject]);

  useEffect(() => {
    const valid = new Map(targets.map(target => [target.key, target]));
    for (const [key, target] of knownTargets.current) {
      if (valid.has(key)) continue;
      const entry = entries.current.get(key);
      if (entry) disposeEntry(key, entry, true);
      else target.client.closeTerminalBridge(target.session.terminalId).catch(() => undefined);
    }
    knownTargets.current = valid;
    for (const [key, entry] of entries.current) {
      const target = valid.get(key);
      if (target) {
        const previousScrollbackMode = terminalScrollbackMode(entry.target.session);
        const nextScrollbackMode = terminalScrollbackMode(target.session);
        entry.target = target;
        if (
          hostReady.current
          && previousScrollbackMode.offlineScrollback !== nextScrollbackMode.offlineScrollback
        ) {
          configureEntry(entry);
        }
        continue;
      }
      disposeEntry(key, entry, true);
    }
    ensureEntry(activeTarget);
    ensureEntry(previewTarget);
    pruneEntries(new Set([
      activeTarget?.key,
      previewTarget?.key,
    ].filter((key): key is string => Boolean(key))));
  }, [activeTarget, configureEntry, disposeEntry, ensureEntry, previewTarget, pruneEntries, targets]);

  const activeTranscriptKey = activeTarget?.key || '';
  const activeTranscriptKind = activeTarget?.session.kind || 'herdr';
  // Connecting, disconnected, and error are all the same cached scrollback mode.
  // Keying this effect on the mode prevents reconnect attempts from replaying the
  // same transcript and snapping an offline reader back to the bottom.
  const activeTranscriptOffline = activeTarget
    ? terminalScrollbackMode(activeTarget.session).offlineScrollback
    : false;
  useEffect(() => {
    if (!hostReady.current || !activeTranscriptKey) return;
    syncOfflineTranscript(
      activeTranscriptKey,
      activeTranscriptKind,
      activeTranscriptOffline,
      offlineTranscript,
      offlineScrollRef.current,
    );
  }, [
    activeTranscriptKey,
    activeTranscriptKind,
    activeTranscriptOffline,
    offlineTranscript,
    syncOfflineTranscript,
  ]);

  useEffect(() => {
    for (const entry of entries.current.values()) {
      if (entry.fontPreference !== preferences.fontSize) {
        entry.fontPreference = preferences.fontSize;
        entry.fontSize = preferences.fontSize;
        reportFontSize(entry.target, entry.fontSize);
      }
      if (hostReady.current) configureEntry(entry);
    }
  }, [configureEntry, preferences]);

  const updateSwipeOffset = useCallback((value: number) => {
    if (!activeTarget || !previewTarget || !swipe) return;
    inject(`window.herdrSwipe(${JSON.stringify(activeTarget.key)}, ${JSON.stringify(previewTarget.key)}, ${swipe.direction}, ${value});`);
  }, [activeTarget, inject, previewTarget, swipe]);

  useAnimatedReaction(
    () => swipe?.offset.value ?? null,
    (value, previousValue) => {
      if (value !== null && value !== previousValue) {
        scheduleOnRN(updateSwipeOffset, value);
      }
    },
    [swipe?.offset, updateSwipeOffset],
  );

  useEffect(() => {
    if (!hostReady.current) return;
    if (!activeTarget) return;
    if (!visible) {
      // Keep only the selected terminal presented and composited behind the
      // foreground app screen. Other cached xterm sessions remain hidden.
      inject(`window.herdrActivate(${JSON.stringify(activeTarget.key)}); window.herdrBlur(${JSON.stringify(activeTarget.key)});`);
      return;
    }
    if (!swipe || !previewTarget) {
      inject(`window.herdrActivate(${JSON.stringify(activeTarget.key)});`);
      return;
    }
    updateSwipeOffset(swipe.offset.get());
    return () => {
      inject(`window.herdrActivate(${JSON.stringify(activeKey.current)});`);
    };
  }, [activeTarget, inject, previewTarget, swipe, updateSwipeOffset, visible]);

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const wasActive = previous === 'active';
      previous = state;
      appState.current = state;
      if (state !== 'active') {
        if (wasActive && preferences.pauseResizeInBackground) {
          for (const entry of entries.current.values()) {
            if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
            entry.reconnectTimer = null;
            entry.controllerAttached = false;
            entry.connecting = false;
            entry.target.client.releaseTerminal(entry.target.session.terminalId).catch(() => undefined);
          }
        }
        return;
      }
      if (wasActive) return;
      for (const entry of entries.current.values()) {
        if (
          preferences.pauseResizeInBackground
          || !entry.target.client.isTerminalBridgeRetained(entry.target.session.terminalId)
        ) {
          entry.controllerAttached = false;
          entry.connecting = false;
          entry.reconnectAttempt = 0;
          connectEntry(entry, !preferences.pauseResizeInBackground);
        }
      }
      if (preferences.pauseResizeInBackground && visible && activeKey.current) {
        inject(`window.herdrFit(${JSON.stringify(activeKey.current)});`);
      }
    });
    return () => subscription.remove();
  }, [connectEntry, inject, preferences.pauseResizeInBackground, visible]);

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
      const entry = activeKey.current ? entries.current.get(activeKey.current) : null;
      if (entry) syncOfflineTranscript(
        entry.target.key,
        entry.target.session.kind,
        terminalScrollbackMode(entry.target.session).offlineScrollback,
        offlineTranscriptRef.current,
        offlineScrollRef.current,
      );
      reportReady();
      return;
    }
    const entry = typeof message.key === 'string' ? entries.current.get(message.key) : null;
    if (!entry) return;
    if (message.type === 'terminal-ready') {
      entry.rendererReady = true;
      const frames = entry.pendingFrames;
      entry.pendingFrames = [];
      for (const pending of frames) injectFrame(entry, pending.frame, pending.traceCookie);
      connectEntry(entry);
      return;
    }
    if (message.type === 'input') {
      if (entry.target.session.status !== 'connected') return;
      await enqueueInput(entry, () => reportInput(entry.target, message.data));
    } else if (message.type === 'buffered-submit') {
      if (entry.target.session.status !== 'connected') return;
      const inputTrace = beginTerminalInputTrace(entry.target.key, 'submit');
      try {
        const pastedParts = Array.isArray(message.parts)
          ? message.parts.filter((part: unknown): part is string => typeof part === 'string')
          : [];
        await enqueueInput(entry, async () => {
          for (const [index, data] of terminalSubmissionWrites(pastedParts).entries()) {
            const write = index === 0 && inputTrace
              ? entry.target.client.writeToTerminal(
                entry.target.session.terminalId,
                data,
                inputTrace,
              )
              : entry.target.client.writeToTerminal(entry.target.session.terminalId, data);
            if (index === 0) endTerminalWriteTrace(inputTrace, true);
            await write;
          }
        });
      } catch (reason) {
        endTerminalWriteTrace(inputTrace, false);
        reportError(entry.target, String(reason));
      }
    } else if (message.type === 'trace-rendered') {
      if (Number.isInteger(message.cookie)) terminalFrameRendered(message.cookie);
    } else if (message.type === 'resize') {
      if (preferences.pauseResizeInBackground && appState.current !== 'active') return;
      entry.target.client.resizeTerminal(
        entry.target.session.terminalId,
        message.cols,
        message.rows,
        message.cellWidthPx,
        message.cellHeightPx,
      );
      entry.sizeReady = true;
      connectEntry(entry);
    } else if (message.type === 'scroll') {
      if (entry.target.session.status !== 'connected') return;
      reportScroll(entry.target, message.direction, message.lines);
      try {
        await entry.target.client.scrollTerminal(
          entry.target.session.terminalId,
          message.direction,
          message.lines,
          message.column,
          message.row,
        );
      } catch (reason) {
        reportError(entry.target, String(reason));
      }
    } else if (message.type === 'offline-scroll') {
      if (
        entry.target.session.kind === 'ssh'
        || !terminalScrollbackMode(entry.target.session).offlineScrollback
      ) return;
      reportOfflineScroll(entry.target, {
        offset_from_bottom: message.offsetFromBottom,
        max_offset_from_bottom: message.maxOffsetFromBottom,
        viewport_rows: message.viewportRows,
      });
    } else if (message.type === 'terminal-click') {
      if (entry.target.session.status !== 'connected') return;
      try {
        await entry.target.client.clickTerminal(
          entry.target.session.terminalId,
          message.column,
          message.row,
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
    } else if (message.type === 'buffer-mode') {
      reportBufferMode(entry.target, message.alternate === true);
    } else if (message.type === 'clipboard-write') {
      Clipboard.setString(message.text || '');
    } else if (message.type === 'clipboard-read') {
      if (entry.target.session.status !== 'connected') return;
      const value = await Clipboard.getString();
      if (value) {
        if (entry.target.session.kind === 'ssh') {
          inject(`window.herdrPaste(${JSON.stringify(entry.target.key)}, ${JSON.stringify(value)});`);
        } else {
          enqueueInput(entry, () => entry.target.client.pasteIntoPane(
            entry.target.session.paneId,
            prepareTerminalPaste(value),
          )).catch(reason => reportError(entry.target, String(reason)));
        }
        reportPaste(entry.target, value);
      }
    } else if (
      entry.target.key === activeKey.current
      && message.type === 'selection-state'
    ) {
      reportSelectionState(entry.target, message.active === true);
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
      source={TERMINAL_SOURCE}
      originWhitelist={['file://*', 'about:blank', 'data:*']}
      allowFileAccess
      allowingReadAccessToURL={Platform.OS === 'ios'
        ? IOS_TERMINAL_ASSET_DIRECTORY
        : undefined}
      javaScriptEnabled
      textZoom={100}
      onMessage={handleMessage}
      onTouchStart={() => {
        if (!visible || !activeKey.current) return;
        webView.current?.requestFocus();
        activeCall('herdrFocus');
      }}
      style={style}
      containerStyle={WEBVIEW_CONTAINER_STYLE}
    />
  );
});
