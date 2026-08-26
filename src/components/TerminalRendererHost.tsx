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
import { TerminalFrameSequence } from '../lib/terminalFrameSequence';
import {
  TerminalArbitration,
  type TerminalDimensions,
  type TerminalInputActivity,
} from '../lib/terminalArbitration';
import { arrayBufferToBase64 } from '../lib/base64';
import {
  isOfflineTerminalNavigationInput,
  TerminalRendererContentState,
  terminalResizeForcesNativeDispatch,
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
  abandonTerminalInboundTrace,
  abandonTerminalRendererReadinessTrace,
  abandonTerminalResizeTrace,
  beginAppPerformanceTrace,
  beginTerminalColdInputWait,
  beginTerminalInputTrace,
  beginTerminalRendererReadinessTrace,
  beginTerminalResizeTrace,
  endAppPerformanceTrace,
  endTerminalWriteTrace,
  terminalInboundFrameVisible,
  terminalInboundRendererReceived,
  terminalInboundWebViewInjectionEnded,
  terminalInboundWebViewInjectionStarted,
  terminalInboundWebViewReceived,
  terminalInboundXtermWritten,
  terminalFrameReceived,
  terminalFrameRendered,
  terminalRendererBecameReady,
  terminalRendererEntryReached,
  terminalRendererSizeBecameReady,
  terminalResizeFrameReceived,
  terminalResizeFrameRendered,
  terminalResizeRequestHandled,
  terminalResizeRequestReady,
  withTerminalWriteTrace,
  type AppPerformanceTrace,
  type TerminalRendererReadinessTrace,
} from '../services/performanceTrace';
import { IOS_TERMINAL_ASSETS } from '../services/terminalAssets';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { PaneScrollInfo } from '../types';

const FRAME_CHUNK_SIZE = 16_384;
const TRANSCRIPT_CHUNK_SIZE = 16_384;
const WEBVIEW_CONTAINER_STYLE = { backgroundColor: 'transparent' } as const;
const IOS_TERMINAL_ASSET_DIRECTORY = IOS_TERMINAL_ASSETS?.directoryURL || '';
const TERMINAL_RENDER_DROP_ENABLED = __DEV__
  && process.env.EXPO_PUBLIC_WHIP_TERMINAL_RENDER_DROP === '1';
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
  pendingFrames: Array<{
    frame: TerminalFrame;
    inputTraceCookie: number | null;
    resizeTraceCookie: number | null;
  }>;
  resetOnNextFrame: boolean;
  contentState: TerminalRendererContentState;
  frameSequence: TerminalFrameSequence;
  repaintRequested: boolean;
  fontPreference: number;
  fontSize: number;
  protocolState: TerminalProtocolState;
  arbitration: TerminalArbitration;
  writableWaiters: Array<{
    resolve: () => void;
    reject: (reason: Error) => void;
  }>;
  readinessTrace: TerminalRendererReadinessTrace | null;
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
  submitPastes: (
    target: TerminalRenderTarget,
    parts: readonly string[],
    newUserInput?: boolean,
  ) => Promise<void>;
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
  onOfflineSnapshot: (targetKey: string, transcript: string) => void;
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
  onOfflineSnapshot,
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
  const serializationTraces = useRef(new Map<string, AppPerformanceTrace>());
  activeKey.current = activeTarget?.key || null;
  offlineTranscriptRef.current = offlineTranscript;
  offlineScrollRef.current = offlineScroll;

  const reportReady = useEffectEvent(() => onReady?.());
  const reportInput = useEffectEvent(onInput);
  const reportScroll = useEffectEvent(onScroll);
  const reportOfflineScroll = useEffectEvent(onOfflineScroll);
  const reportOfflineSnapshot = useEffectEvent(onOfflineSnapshot);
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
    abandonTerminalRendererReadinessTrace(entry.readinessTrace);
    entry.readinessTrace = null;
    entry.controllerAttached = false;
    entry.connecting = false;
    for (const waiter of entry.writableWaiters.splice(0)) {
      waiter.reject(new Error('Terminal renderer was disposed'));
    }
    entries.current.delete(key);
    const terminalId = entry.target.session.terminalId;
    if (closeBridge) {
      entry.target.client.closeTerminalBridge(terminalId).catch(() => undefined);
    } else {
      entry.target.client.detachTerminal(terminalId).catch(() => undefined);
    }
    if (hostReady.current) {
      const serializedKey = JSON.stringify(key);
      const snapshot = !closeBridge
        && entry.target.session.kind !== 'ssh'
        && entry.contentState.hasRenderedState
        ? `window.herdrSnapshot(${serializedKey}, "eviction"); `
        : '';
      inject(`${snapshot}window.herdrRemove(${serializedKey});`);
    }
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
      offlineCache: entry.target.session.kind !== 'ssh',
    })}); window.herdrSetRenderDrop(${JSON.stringify(entry.target.key)}, ${TERMINAL_RENDER_DROP_ENABLED});`);
  }, [inject, preferences]);

  const syncOfflineTranscript = useCallback((
    entry: RendererEntry,
    transcript: string,
    scroll?: PaneScrollInfo,
  ) => {
    const key = JSON.stringify(entry.target.key);
    const action = entry.contentState.restoreAction(entry.target.session.kind, transcript);
    if (action === 'hide') {
      inject(`window.herdrHideOfflineTranscript(${key});`);
      return;
    }
    // A mounted renderer already contains the interpreted live xterm state.
    // Replaying a cache here would replace newer scrollback with a stale copy.
    if (action === 'preserve') return;
    inject(`window.herdrBeginOfflineTranscript(${key});`);
    for (let offset = 0; offset < transcript.length; offset += TRANSCRIPT_CHUNK_SIZE) {
      inject(`window.herdrAppendOfflineTranscript(${key}, ${JSON.stringify(
        transcript.slice(offset, offset + TRANSCRIPT_CHUNK_SIZE),
      )});`);
    }
    inject(`window.herdrCommitOfflineTranscript(${key}, ${scroll?.offset_from_bottom || 0});`);
    entry.contentState.restoredFromCache();
  }, [inject]);

  const requestFullFrame = useCallback((entry: RendererEntry) => {
    if (entry.repaintRequested) return;
    const dimensions = entry.arbitration.latestDimensions();
    if (!dimensions) return;
    entry.repaintRequested = true;
    const trace = beginAppPerformanceTrace('Whip terminal sequence recovery');
    recordNetworkDiagnostic('warn', 'terminal-sequence-gap', {
      sessionId: entry.target.hostSessionId,
      terminalId: entry.target.session.terminalId,
    });
    entry.target.client.resizeTerminal(
      entry.target.session.terminalId,
      dimensions.columns,
      dimensions.rows,
      dimensions.cellWidthPx,
      dimensions.cellHeightPx,
      null,
      // Herdr marks every terminal-ANSI resize as repaint_pending. The next
      // frame is therefore a full visible baseline without a pane.read.
      true,
    ).catch(reason => {
      entry.repaintRequested = false;
      reportError(entry.target, String(reason));
    }).finally(() => endAppPerformanceTrace(trace));
  }, []);

  const injectFrame = useCallback((
    entry: RendererEntry,
    frame: TerminalFrame,
    inputTraceCookie: number | null = terminalFrameReceived(entry.target.key),
    resizeTraceCookie: number | null = terminalResizeFrameReceived(entry.target.key),
  ) => {
    const inboundTraceCookie = frame.inboundTraceCookie ?? null;
    terminalInboundRendererReceived(inboundTraceCookie);
    if (!hostReady.current || !entry.rendererReady) {
      entry.pendingFrames.push({ frame, inputTraceCookie, resizeTraceCookie });
      return;
    }
    if (entry.target.session.kind !== 'ssh' && frame.encoding === 'ansi') {
      const sequence = entry.frameSequence.observe(frame);
      if (sequence.requestFull) requestFullFrame(entry);
      if (!sequence.render) {
        abandonTerminalInboundTrace(inboundTraceCookie);
        return;
      }
      if (sequence.reset) entry.resetOnNextFrame = true;
      if (frame.full) entry.repaintRequested = false;
    }
    const key = JSON.stringify(entry.target.key);
    const serializedInputTraceCookie = inputTraceCookie === null
      ? 'null'
      : String(inputTraceCookie);
    const serializedResizeTraceCookie = resizeTraceCookie === null
      ? 'null'
      : String(resizeTraceCookie);
    const reset = entry.resetOnNextFrame;
    if (reset) entry.resetOnNextFrame = false;
    entry.contentState.receivedLiveFrame();
    const resetScript = reset ? `window.herdrReset(${key}); ` : '';
    const serializedInboundTraceCookie = inboundTraceCookie === null
      ? 'null'
      : String(inboundTraceCookie);
    const injectTracedFrame = (script: string) => {
      terminalInboundWebViewInjectionStarted(inboundTraceCookie);
      try {
        inject(script);
      } finally {
        terminalInboundWebViewInjectionEnded(inboundTraceCookie);
      }
    };
    if (frame.encoding === 'utf8') {
      if (typeof frame.bytes !== 'string') {
        abandonTerminalInboundTrace(inboundTraceCookie);
        return;
      }
      injectTracedFrame(`${resetScript}window.herdrWrite(${key}, ${JSON.stringify(frame.bytes)}, ${serializedInputTraceCookie}, ${serializedResizeTraceCookie}, ${serializedInboundTraceCookie});`);
      return;
    }
    if (typeof frame.bytes === 'string' && typeof frame.final === 'boolean') {
      injectTracedFrame(`${resetScript}window.herdrWriteBase64Chunk(${key}, ${frame.seq}, ${JSON.stringify(frame.bytes)}, ${frame.final}, ${serializedInputTraceCookie}, ${serializedResizeTraceCookie}, ${serializedInboundTraceCookie});`);
      return;
    }
    const encoded = typeof frame.bytes === 'string'
      ? frame.bytes
      : arrayBufferToBase64(frame.bytes);
    const writes: string[] = [];
    if (encoded.length === 0) {
      writes.push(`window.herdrWriteBase64Chunk(${key}, ${frame.seq}, "", true, ${serializedInputTraceCookie}, ${serializedResizeTraceCookie}, ${serializedInboundTraceCookie});`);
    } else {
      for (let offset = 0; offset < encoded.length; offset += FRAME_CHUNK_SIZE) {
        const chunk = encoded.slice(offset, offset + FRAME_CHUNK_SIZE);
        const final = offset + FRAME_CHUNK_SIZE >= encoded.length;
        const finalTraceCookie = final
          ? `, ${serializedInputTraceCookie}, ${serializedResizeTraceCookie}, ${serializedInboundTraceCookie}`
          : '';
        writes.push(`window.herdrWriteBase64Chunk(${key}, ${frame.seq}, ${JSON.stringify(chunk)}, ${final}${finalTraceCookie});`);
      }
    }
    // A frame can require multiple chunks, but it crosses into the WebView once.
    injectTracedFrame(`${resetScript}${writes.join('')}`);
  }, [inject, requestFullFrame]);

  const connectEntry = useCallback((entry: RendererEntry, showConnecting = true) => {
    if (preferences.pauseResizeInBackground && appState.current !== 'active') return;
    if (entry.arbitration.state.yielded) return;
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
      entry.frameSequence.reset();
      entry.repaintRequested = false;
      if (showConnecting) {
        reportStatus(entry.target, 'connecting', undefined, 0);
      }
    }
    const scheduleReconnect = (reason: string, displacement: boolean) => {
      if (entries.current.get(entry.target.key) !== entry) return;
      entry.connecting = false;
      entry.controllerAttached = false;
      if (AppState.currentState !== 'active') return;
      if (
        displacement
        && entry.target.session.kind !== 'ssh'
        && entry.arbitration.recordDisplacement()
      ) {
        recordNetworkDiagnostic('info', 'terminal-reconnect-yielded', {
          sessionId: entry.target.hostSessionId,
          terminalId,
          inputGeneration: entry.arbitration.state.inputGeneration,
          displacements: entry.arbitration.state.consecutiveDisplacements,
          reason: networkErrorMessage(reason),
        });
        // There is no passive terminal status. Keep the cached surface usable
        // so its next real input can reclaim ownership through this host.
        reportStatus(entry.target, 'connected', undefined, 0);
        entry.target.client.releaseTerminal(terminalId).catch(() => undefined);
        return;
      }
      // HostRuntime owns terminal retry/backoff and native bridge generations.
      recordNetworkDiagnostic('error', 'terminal-recovery-native-failed', {
        sessionId: entry.target.hostSessionId,
        terminalId,
        reason: networkErrorMessage(reason),
      });
      reportStatus(entry.target, 'error', reason, 0);
      for (const waiter of entry.writableWaiters.splice(0)) waiter.reject(new Error(reason));
    };
    client.openTerminal(
      terminalId,
      frame => injectFrame(entry, frame),
      reason => scheduleReconnect(reason || 'Remote terminal closed', true),
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
      if (!entry.controllerAttached) return;
      entry.connecting = false;
      reportStatus(entry.target, 'connected', undefined, 0);
      for (const waiter of entry.writableWaiters.splice(0)) waiter.resolve();
      if (
        retained
        && !entry.contentState.hasLiveState
        && entry.target.session.kind !== 'ssh'
      ) {
        entry.frameSequence.reset();
        requestFullFrame(entry);
      }
    }).catch(reason => {
      if (entries.current.get(entry.target.key) !== entry) return;
      const message = String(reason);
      entry.connecting = false;
      entry.controllerAttached = false;
      reportError(entry.target, message);
      scheduleReconnect(message, false);
    });
  }, [injectFrame, preferences.pauseResizeInBackground, requestFullFrame]);

  const ensureEntry = useCallback((target: TerminalRenderTarget | null | undefined): RendererEntry | null => {
    if (!target) return null;
    let entry = touchTerminalRendererEntry(entries.current, target.key);
    if (!entry) {
      const readinessTrace = beginTerminalRendererReadinessTrace();
      entry = {
        target,
        rendererReady: false,
        sizeReady: false,
        controllerAttached: false,
        connecting: false,
        pendingFrames: [],
        resetOnNextFrame: true,
        contentState: new TerminalRendererContentState(),
        frameSequence: new TerminalFrameSequence(),
        repaintRequested: false,
        fontPreference: preferences.fontSize,
        fontSize: target.session.fontSize ?? preferences.fontSize,
        protocolState: {
          kittyKeyboardReportAll: false,
        },
        arbitration: new TerminalArbitration(),
        writableWaiters: [],
        readinessTrace,
      };
      entries.current.set(target.key, entry);
      if (hostReady.current) {
        inject(`window.herdrCreate(${JSON.stringify(target.key)});`);
        configureEntry(entry);
      }
    } else {
      entry.target = target;
    }
    terminalRendererEntryReached(target.session.terminalId);
    connectEntry(entry);
    return entry;
  }, [configureEntry, connectEntry, inject, preferences.fontSize]);

  const activeCall = useCallback((method: string, args: unknown[] = []) => {
    const key = activeKey.current;
    if (!key) return;
    inject(`window.${method}(${[JSON.stringify(key), ...args.map(value => JSON.stringify(value))].join(', ')});`);
  }, [inject]);

  const waitForWritable = useCallback((entry: RendererEntry): Promise<void> => {
    const terminalId = entry.target.session.terminalId;
    if (
      entry.controllerAttached
      && !entry.connecting
      && entry.target.client.isTerminalBridgeRetained(terminalId)
    ) return Promise.resolve();
    const pending = new Promise<void>((resolve, reject) => {
      entry.writableWaiters.push({ resolve, reject });
    });
    connectEntry(entry);
    return pending;
  }, [connectEntry]);

  const enqueueInput = useCallback((
    entry: RendererEntry,
    operation: () => void | Promise<void>,
    newUserInput = true,
  ) => {
    const terminalId = entry.target.session.terminalId;
    const writable = entry.controllerAttached
      && !entry.connecting
      && entry.target.client.isTerminalBridgeRetained(terminalId);
    const coldWaitTrace: AppPerformanceTrace | null = writable
      ? null
      : beginTerminalColdInputWait();
    return entry.arbitration.queueUserInput({
      newUserInput,
      onActivity: () => {
        connectEntry(entry);
      },
      prepare: async (activity: TerminalInputActivity, dimensions: TerminalDimensions | null) => {
        try {
          await waitForWritable(entry);
        } finally {
          endAppPerformanceTrace(coldWaitTrace);
        }
        if (!activity.reclaimRequired || !dimensions) return;
        await entry.target.client.resizeTerminal(
          entry.target.session.terminalId,
          dimensions.columns,
          dimensions.rows,
          dimensions.cellWidthPx,
          dimensions.cellHeightPx,
          null,
          // Reassert ownership even when the geometry tuple is unchanged.
          true,
        );
      },
      send: operation,
    }).finally(() => endAppPerformanceTrace(coldWaitTrace));
  }, [connectEntry, waitForWritable]);

  const reportQueuedInput = useCallback((entry: RendererEntry, data: string) => {
    const target = entry.target.session.status === 'connected'
      ? entry.target
      : {
          ...entry.target,
          session: { ...entry.target.session, status: 'connected' as const },
        };
    return reportInput(target, data);
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
      if (!entry) return false;
      if (
        entry.target.session.status !== 'connected'
        && !entry.arbitration.state.yielded
        && entry.arbitration.state.consecutiveDisplacements === 0
        && isOfflineTerminalNavigationInput(data)
      ) {
        activeCall('herdrOfflineInput', [data]);
        return true;
      }
      enqueueInput(entry, () => reportQueuedInput(entry, data)).catch(
        reason => reportError(entry.target, String(reason)),
      );
      return true;
    },
    paste: data => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (!entry) return;
      if (
        entry.target.session.status !== 'connected'
        && entry.target.session.kind === 'ssh'
      ) return;
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
      entry.controllerAttached = false;
      entry.connecting = false;
      entry.arbitration.resumeManually();
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
    submitPastes: (target, parts, newUserInput = true) => {
      const entry = ensureEntry(target);
      if (!entry) return Promise.reject(new Error('Terminal is not available'));
      if (
        entry.target.session.status !== 'connected'
        && entry.target.session.kind === 'ssh'
      ) {
        return Promise.reject(new Error('Terminal is offline and read-only'));
      }
      if (entry.target.session.kind === 'ssh') {
        inject(`window.herdrSubmitPastes(${JSON.stringify(target.key)}, ${JSON.stringify(parts)});`);
        return Promise.resolve();
      }
      const prepared = parts.map(prepareTerminalPaste);
      const inputTrace = beginTerminalInputTrace(entry.target.key, 'submit');
      return enqueueInput(entry, () => withTerminalWriteTrace(
        inputTrace,
        () => entry.target.client.submitPastesToPane(
          entry.target.session.paneId,
          prepared,
        ),
      ), newUserInput).catch(reason => {
        endTerminalWriteTrace(inputTrace, false);
        reportError(entry.target, String(reason));
        throw reason;
      });
    },
  }), [activeCall, connectEntry, enqueueInput, ensureEntry, inject, reportQueuedInput]);

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
  useEffect(() => {
    if (!hostReady.current || !activeTranscriptKey) return;
    const entry = entries.current.get(activeTranscriptKey);
    if (!entry) return;
    syncOfflineTranscript(
      entry,
      offlineTranscript,
      offlineScrollRef.current,
    );
  }, [
    activeTranscriptKey,
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
        if (wasActive && hostReady.current) {
          for (const entry of entries.current.values()) {
            if (
              entry.target.session.kind !== 'ssh'
              && entry.contentState.hasRenderedState
            ) {
              inject(`window.herdrSnapshot(${JSON.stringify(entry.target.key)}, "background");`);
            }
          }
        }
        if (wasActive && preferences.pauseResizeInBackground) {
          for (const entry of entries.current.values()) {
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
      if (
        hostReady.current
        && entry.target.session.kind !== 'ssh'
        && entry.contentState.hasRenderedState
      ) {
        inject(`window.herdrSnapshot(${JSON.stringify(entry.target.key)}, "detach");`);
      }
      entry.target.client.detachTerminal(entry.target.session.terminalId).catch(() => undefined);
    }
    for (const trace of serializationTraces.current.values()) {
      endAppPerformanceTrace(trace);
    }
    serializationTraces.current.clear();
    entries.current.clear();
  }, [inject]);

  const handleMessage = async (event: WebViewMessageEvent) => {
    const message = JSON.parse(event.nativeEvent.data);
    if (message.type === 'ready') {
      const reloaded = hostReady.current;
      hostReady.current = true;
      for (const entry of entries.current.values()) {
        if (reloaded) {
          entry.rendererReady = false;
          entry.sizeReady = false;
          entry.resetOnNextFrame = true;
          entry.contentState = new TerminalRendererContentState();
          entry.frameSequence.reset();
          entry.repaintRequested = false;
        }
        inject(`window.herdrCreate(${JSON.stringify(entry.target.key)});`);
        configureEntry(entry);
      }
      if (visible && activeKey.current) {
        inject(`window.herdrActivate(${JSON.stringify(activeKey.current)});`);
      }
      const entry = activeKey.current ? entries.current.get(activeKey.current) : null;
      if (entry) syncOfflineTranscript(
        entry,
        offlineTranscriptRef.current,
        offlineScrollRef.current,
      );
      reportReady();
      return;
    }
    if (message.type === 'cache-snapshot-start' && typeof message.key === 'string') {
      endAppPerformanceTrace(serializationTraces.current.get(message.key) || null);
      const trace = beginAppPerformanceTrace('Whip terminal offline cache serialize');
      if (trace) serializationTraces.current.set(message.key, trace);
      else serializationTraces.current.delete(message.key);
      return;
    }
    if (message.type === 'cache-snapshot' && typeof message.key === 'string') {
      endAppPerformanceTrace(serializationTraces.current.get(message.key) || null);
      serializationTraces.current.delete(message.key);
      if (typeof message.transcript === 'string') {
        reportOfflineSnapshot(message.key, message.transcript);
      }
      return;
    }
    if (message.type === 'trace-write-received') {
      if (Number.isInteger(message.inboundCookie)) {
        terminalInboundWebViewReceived(message.inboundCookie);
      }
      return;
    }
    if (message.type === 'trace-xterm-written') {
      if (Number.isInteger(message.inboundCookie)) {
        terminalInboundXtermWritten(message.inboundCookie);
      }
      return;
    }
    if (message.type === 'trace-rendered') {
      if (Number.isInteger(message.inputCookie)) terminalFrameRendered(message.inputCookie);
      else if (Number.isInteger(message.cookie)) terminalFrameRendered(message.cookie);
      if (Number.isInteger(message.resizeCookie)) {
        terminalResizeFrameRendered(message.resizeCookie);
      }
      if (Number.isInteger(message.inboundCookie)) {
        terminalInboundFrameVisible(message.inboundCookie);
      }
      return;
    }
    const entry = typeof message.key === 'string' ? entries.current.get(message.key) : null;
    if (!entry) return;
    if (message.type === 'terminal-ready') {
      entry.rendererReady = true;
      terminalRendererBecameReady(entry.readinessTrace);
      const frames = entry.pendingFrames;
      entry.pendingFrames = [];
      for (const pending of frames) injectFrame(
        entry,
        pending.frame,
        pending.inputTraceCookie,
        pending.resizeTraceCookie,
      );
      if (entry.target.key === activeKey.current) {
        syncOfflineTranscript(
          entry,
          offlineTranscriptRef.current,
          offlineScrollRef.current,
        );
      }
      if (
        entry.controllerAttached
        && !entry.contentState.hasLiveState
        && entry.target.session.kind !== 'ssh'
      ) {
        requestFullFrame(entry);
      }
      connectEntry(entry);
      return;
    }
    if (message.type === 'input') {
      await enqueueInput(entry, () => reportQueuedInput(entry, message.data));
    } else if (message.type === 'buffered-submit') {
      const inputTrace = beginTerminalInputTrace(entry.target.key, 'submit');
      try {
        const pastedParts = Array.isArray(message.parts)
          ? message.parts.filter((part: unknown): part is string => typeof part === 'string')
          : [];
        await enqueueInput(entry, async () => {
          for (const [index, data] of terminalSubmissionWrites(pastedParts).entries()) {
            if (index === 0) {
              await withTerminalWriteTrace(
                inputTrace,
                () => inputTrace
                  ? entry.target.client.writeToTerminal(
                    entry.target.session.terminalId,
                    data,
                    inputTrace,
                  )
                  : entry.target.client.writeToTerminal(entry.target.session.terminalId, data),
              );
            } else {
              await entry.target.client.writeToTerminal(
                entry.target.session.terminalId,
                data,
              );
            }
          }
        });
      } catch (reason) {
        endTerminalWriteTrace(inputTrace, false);
        reportError(entry.target, String(reason));
      }
    } else if (message.type === 'resize') {
      const source = message.source === 'fit' ? 'fit' : 'xterm';
      const resizeTrace = beginTerminalResizeTrace(
        entry.target.key,
        source,
        message.cols,
        message.rows,
        message.cellWidthPx || 0,
        message.cellHeightPx || 0,
        message.localFitMs,
        Number.isFinite(message.requestedAtEpochMs)
          ? Date.now() - message.requestedAtEpochMs
          : undefined,
      );
      try {
        const dimensions = {
          columns: message.cols,
          rows: message.rows,
          cellWidthPx: message.cellWidthPx,
          cellHeightPx: message.cellHeightPx,
        };
        entry.arbitration.cacheDimensions(dimensions);
        entry.sizeReady = true;
        terminalRendererSizeBecameReady(entry.readinessTrace);
        if (!entry.arbitration.shouldSendResize()) {
          terminalResizeRequestReady(resizeTrace);
          abandonTerminalResizeTrace(resizeTrace);
          return;
        }
        if (preferences.pauseResizeInBackground && appState.current !== 'active') {
          terminalResizeRequestReady(resizeTrace);
          abandonTerminalResizeTrace(resizeTrace);
          return;
        }
        terminalResizeRequestReady(resizeTrace);
        await entry.target.client.resizeTerminal(
          entry.target.session.terminalId,
          dimensions.columns,
          dimensions.rows,
          dimensions.cellWidthPx,
          dimensions.cellHeightPx,
          resizeTrace,
          // A fit is also a redraw/reflow signal after presenting a terminal,
          // even when its geometry tuple matches the last native resize.
          terminalResizeForcesNativeDispatch(source),
        );
        connectEntry(entry);
      } finally {
        terminalResizeRequestReady(resizeTrace);
        terminalResizeRequestHandled(resizeTrace);
      }
    } else if (message.type === 'scroll') {
      if (
        entry.target.session.status !== 'connected'
        || entry.arbitration.state.yielded
      ) return;
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
      try {
        await enqueueInput(entry, () => entry.target.client.clickTerminal(
          entry.target.session.terminalId,
          message.column,
          message.row,
        ));
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
      if (
        entry.target.session.status !== 'connected'
        && entry.target.session.kind === 'ssh'
      ) return;
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
