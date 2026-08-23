import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Portal } from '@rn-primitives/portal';
import { ArrowBigUp, ArrowDown, ArrowLeft, ArrowRight, ArrowRightToLine, ArrowUp, ChevronDown, ChevronUp, ClipboardPaste, CornerDownLeft, FolderOpen, History, Keyboard as KeyboardIcon, Maximize2, MessageCircle, Minimize2, Option, Paperclip, Search, Send, Undo2, X, type LucideIcon } from 'lucide-react-native';
import { AppState, Clipboard, Image, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, View, type GestureResponderHandlers, type TextInput as TextInputHandle } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { useKeyboardInset } from '@/src/hooks/useKeyboardInset';
import { cn } from '@/src/lib/utils';
import {
  orderTerminalControls,
  type TerminalControlId,
  type TerminalControlUsage,
} from '../lib/terminalControls';
import { OfflineTerminalBackend } from '../lib/offlineTerminalBackend';
import {
  directTerminalKeyboardEnabled,
  terminalScrollbackMode,
  type TerminalRenderTarget,
} from '../lib/terminalRenderer';
import type { TerminalProtocolState } from '../lib/terminalBridge';
import type { TerminalPreferences } from '../services/devicePreferences';
import { beginTerminalInputTrace, endTerminalWriteTrace } from '../services/performanceTrace';
import { setTerminalComposerOverlay } from '../services/terminalSoftInput';
import { applyTerminalModifiers, type TerminalModifierState } from '../lib/terminalInput';
import { moveTerminalScroll, terminalScrollThumb } from '../lib/terminalScroll';
import { composeTerminalSubmission } from '../lib/terminalSubmission';
import { terminalTranscript } from '../lib/terminalTranscript';
import { resolveTerminalVolumeKeyAction, type TerminalVolumeKey } from '../lib/volumeKeys';
import { addTerminalVolumeKeyListener } from '../services/volumeKeys';
import { terminalFontFamily } from '../lib/terminalFonts';
import type { TerminalSessionStatus } from '../terminalSessions';
import { colors, useTheme } from '../theme';
import {
  TerminalRendererHost,
  type TerminalRendererHandle,
} from './TerminalRendererHost';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  activeTarget: TerminalRenderTarget | null;
  previewTarget?: TerminalRenderTarget | null;
  targets: readonly TerminalRenderTarget[];
  visible: boolean;
  preferences: TerminalPreferences;
  controlUsage: TerminalControlUsage;
  historyEntries: readonly string[];
  compact?: boolean;
  topOverlayInset?: number;
  swipe?: {
    direction: -1 | 1;
    offset: SharedValue<number>;
  } | null;
  terminalPanHandlers?: GestureResponderHandlers;
  onControlUse: (control: TerminalControlId) => void;
  onHistoryEntry: (entry: string) => void;
  getComposerDraft: (terminalId: string) => string;
  onComposerDraftChange: (terminalId: string, value: string) => void;
  linkScanRequest?: number;
  pasteRequest?: {
    id: number;
    text: string;
    previewUri?: string | null;
    dispose?: () => void;
  };
  onRequestAttachment?: () => void;
  onRequestFiles?: () => void;
  onOpenLink?: (link: string) => void;
  onLinksScanned?: (links: string[]) => void;
  onInteraction?: (target: TerminalRenderTarget) => void;
  onClose: () => void;
  onStatus: (
    target: TerminalRenderTarget,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => void;
}

type TerminalKeyDefinition = readonly [label: string, input: string, face: 'text' | 'symbol'];

const ENTER_INPUT = '\r';

const TERMINAL_KEYS: Partial<Record<TerminalControlId, TerminalKeyDefinition>> = {
  esc: ['ESC', '\u001b', 'text'],
  tab: ['TAB', '\t', 'text'],
  up: ['↑', '\u001b[A', 'symbol'],
  left: ['←', '\u001b[D', 'symbol'],
  right: ['→', '\u001b[C', 'symbol'],
  down: ['↓', '\u001b[B', 'symbol'],
  enter: ['ENTER', ENTER_INPUT, 'text'],
  slash: ['/', '/', 'symbol'],
  hyphen: ['-', '-', 'symbol'],
  pipe: ['|', '|', 'symbol'],
  tilde: ['~', '~', 'symbol'],
  end: ['END', '\u001b[F', 'text'],
  'page-up': ['PG↑', '\u001b[5~', 'text'],
  'page-down': ['PG↓', '\u001b[6~', 'text'],
  'shift-tab': ['⇧TAB', '\u001b[Z', 'text'],
  home: ['HOME', '\u001b[H', 'text'],
};

interface TerminalIconDefinition {
  accessibilityKey: string;
  icon?: LucideIcon;
  label?: string;
}

const TERMINAL_KEY_ICONS: Partial<Record<TerminalControlId, TerminalIconDefinition>> = {
  up: { icon: ArrowUp, accessibilityKey: 'terminal.upKey' },
  left: { icon: ArrowLeft, accessibilityKey: 'terminal.leftKey' },
  right: { icon: ArrowRight, accessibilityKey: 'terminal.rightKey' },
  down: { icon: ArrowDown, accessibilityKey: 'terminal.downKey' },
};

const ICONIC_TERMINAL_KEYS: Partial<Record<TerminalControlId, TerminalIconDefinition>> = {
  esc: { label: '⎋', accessibilityKey: 'terminal.escapeKey' },
  tab: { icon: ArrowRightToLine, accessibilityKey: 'terminal.tabKey' },
  enter: { icon: CornerDownLeft, accessibilityKey: 'terminal.enterKey' },
};

const WEBVIEW_STYLE = { flex: 1, backgroundColor: 'transparent' } as const;
const BACKGROUND_SCREEN_STYLE = { mixBlendMode: 'screen' } as const;
const TERMINAL_ICON_CONTROL_CLASS = 'h-9 w-11 items-center justify-center rounded-sm border border-border bg-card/70 p-0 active:bg-card/80';
const TERMINAL_TEXT_CONTROL_CLASS = 'h-9 min-w-11 items-center justify-center rounded-sm border border-border bg-card/70 px-2.5 py-0 active:bg-card/80';
const TERMINAL_ICON_BOX_CLASS = 'size-5 items-center justify-center';
const TERMINAL_ICON_SIZE = 18;
const TERMINAL_CONTROL_BAR_HEIGHT = 50;
const TERMINAL_CONTROL_LABEL_STYLE = {
  includeFontPadding: false,
  textAlignVertical: 'center',
} as const;
const MAX_RECONNECT_ATTEMPTS = 5;

type ComposerInputProps = Omit<React.ComponentProps<typeof Input>, 'defaultValue' | 'value'> & {
  initialValue: string;
};

function ComposerInput({ initialValue, ...props }: ComposerInputProps) {
  // React Native sends `defaultValue` to Android as the native text prop. Keep
  // it stable for this mounted input so partial IME results are never written
  // back over the keyboard's active composing span.
  const nativeInitialValue = useRef(initialValue).current;
  return <Input {...props} defaultValue={nativeInitialValue} />;
}

export function TerminalBackground({ preferences }: { preferences: TerminalPreferences }) {
  if (!preferences.backgroundImageUri) return null;

  return (
    <View
      accessibilityElementsHidden
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, BACKGROUND_SCREEN_STYLE]}>
      <Image
        resizeMode="cover"
        source={{ uri: preferences.backgroundImageUri }}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: `rgba(0,0,0,${preferences.backgroundDimming / 100})` },
        ]}
      />
    </View>
  );
}

function useTerminalModifierState() {
  const [value, setValue] = useState<TerminalModifierState>('off');
  const valueRef = useRef<TerminalModifierState>('off');
  const update = useCallback((
    next: TerminalModifierState | ((current: TerminalModifierState) => TerminalModifierState),
  ) => {
    const resolved = typeof next === 'function' ? next(valueRef.current) : next;
    valueRef.current = resolved;
    setValue(resolved);
  }, []);
  return [value, valueRef, update] as const;
}

export function TerminalScreen({
  activeTarget,
  previewTarget,
  targets,
  visible,
  preferences,
  controlUsage,
  historyEntries,
  compact = false,
  topOverlayInset = 0,
  swipe,
  terminalPanHandlers,
  onControlUse,
  onHistoryEntry,
  getComposerDraft,
  onComposerDraftChange,
  linkScanRequest = 0,
  pasteRequest,
  onRequestAttachment,
  onRequestFiles,
  onOpenLink,
  onLinksScanned,
  onInteraction,
  onClose,
  onStatus,
}: Props) {
  const { colors: appColors } = useTheme();
  const { t } = useTranslation();
  const { bottom: bottomSafeAreaInset, top: topSafeAreaInset } = useSafeAreaInsets();
  const session = activeTarget?.session || null;
  const terminalId = session?.terminalId || '';
  const sessionTitle = session?.title || '';
  const status = session?.status || 'connecting';
  const renderer = useRef<TerminalRendererHandle | null>(null);
  const activeTargetRef = useRef(activeTarget);
  const controlsRef = useRef<View | null>(null);
  const handledPasteRequest = useRef(0);
  const composeAttachmentsByTargetRef = useRef(new Map<string, ComposeAttachment[]>());
  const composeAttachmentsRef = useRef<ComposeAttachment[]>([]);
  const queuedMessagesByTargetRef = useRef(new Map<string, QueuedComposerMessage[]>());
  const queuedMessageSequenceRef = useRef(0);
  const queueFlushesRef = useRef(new Set<string>());
  const queueRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const offlineBackendRef = useRef(new OfflineTerminalBackend());
  const flushQueuedTargetRef = useRef<(target: TerminalRenderTarget) => void>(() => {});
  const targetsRef = useRef(targets);
  const composeInputRef = useRef<TextInputHandle | null>(null);
  const composeTextRef = useRef('');
  const wasVisible = useRef(visible);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctrl, ctrlRef, setCtrl] = useTerminalModifierState();
  const [shift, shiftRef, setShift] = useTerminalModifierState();
  const [alt, altRef, setAlt] = useTerminalModifierState();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResult, setSearchResult] = useState({ count: 0, index: -1, invalid: false });
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeExpanded, setComposeExpanded] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedComposerMessage[]>([]);
  const [, setOfflineBackendRevision] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [keyboardEnabled, setKeyboardEnabled] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const { inset: keyboardInset } = useKeyboardInset(controlsRef, {
    enabled: keyboardEnabled,
    onVisibilityChange: setKeyboardVisible,
  });
  const [terminalSelectionActive, setTerminalSelectionActive] = useState(false);
  const [alternateScreen, setAlternateScreen] = useState(false);
  const [reportedTitle, setReportedTitle] = useState('');
  const [protocolState, setProtocolState] = useState<TerminalProtocolState>({
    kittyKeyboardReportAll: false,
  });
  const [scrollPosition, setScrollPosition] = useState(activeTarget?.scroll);
  const [controlOrder] = useState(() => orderTerminalControls(controlUsage));
  const scrollThumb = alternateScreen ? null : terminalScrollThumb(scrollPosition);
  const title = reportedTitle || sessionTitle;
  const directKeyboardEnabled = directTerminalKeyboardEnabled(
    status,
    keyboardEnabled,
    composeOpen,
  );
  const composerKeyboardEnabled = composeOpen && keyboardEnabled;
  const keyboardControlDisabled = status !== 'connected' && !composeOpen;
  const keyboardControlSelected = keyboardEnabled && !keyboardControlDisabled;
  activeTargetRef.current = activeTarget;
  targetsRef.current = targets;

  useEffect(() => {
    const nextComposeText = terminalId ? getComposerDraft(terminalId) : '';
    const nextComposeAttachments = activeTarget?.key
      ? composeAttachmentsByTargetRef.current.get(activeTarget.key) || []
      : [];
    composeTextRef.current = nextComposeText;
    setComposeText(nextComposeText);
    composeAttachmentsRef.current = nextComposeAttachments;
    setComposeAttachments(nextComposeAttachments);
    setQueuedMessages(activeTarget?.key
      ? queuedMessagesByTargetRef.current.get(activeTarget.key) || []
      : []);
    setError(null);
    setSearchOpen(false);
    setComposeOpen(false);
    setComposeExpanded(false);
    setTerminalSelectionActive(false);
    setAlternateScreen(false);
    setReportedTitle('');
    setProtocolState({ kittyKeyboardReportAll: false });
    setHistoryOpen(false);
    setCtrl('off');
    setShift('off');
    setAlt('off');
  }, [activeTarget?.key, getComposerDraft, setAlt, setCtrl, setShift, terminalId]);

  const cacheTargetKey = activeTarget?.key || '';
  const cacheTargetClient = activeTarget?.client || null;
  const cacheTargetPaneId = activeTarget?.session.paneId || '';
  const cacheTargetKind = activeTarget?.session.kind;
  const cacheTargetStatus = activeTarget?.session.status;
  const cacheLineLimit = preferences.scrollback;
  const offlineSnapshot = offlineBackendRef.current.snapshot(cacheTargetKey);

  useEffect(() => {
    offlineBackendRef.current.retain(new Set(targets.map(target => target.key)));
  }, [targets]);

  useEffect(() => {
    if (!cacheTargetKey) return;
    if (
      !visible
      || !cacheTargetClient
      || cacheTargetKind === 'ssh'
      || cacheTargetStatus !== 'connected'
    ) return;
    let cancelled = false;
    let requestInFlight = false;
    const refreshCache = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const output = await cacheTargetClient.readPane(cacheTargetPaneId, cacheLineLimit);
        if (cancelled || !output) return;
        const transcript = terminalTranscript(output, cacheLineLimit);
        offlineBackendRef.current.updateTranscript(cacheTargetKey, transcript);
        if (activeTargetRef.current?.key === cacheTargetKey) {
          setOfflineBackendRevision(value => value + 1);
        }
      } catch {
        // The existing cache remains readable when its refresh loses the network.
      } finally {
        requestInFlight = false;
      }
    };
    refreshCache();
    const timer = setInterval(refreshCache, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    cacheLineLimit,
    cacheTargetClient,
    cacheTargetKey,
    cacheTargetKind,
    cacheTargetPaneId,
    cacheTargetStatus,
    visible,
  ]);

  const activeUsesOfflineScroll = Boolean(
    activeTarget
      && activeTarget.session.kind !== 'ssh'
      && terminalScrollbackMode(activeTarget.session).offlineScrollback,
  );
  const activeTargetKey = activeTarget?.key || '';
  const activeRemoteScroll = activeTarget?.scroll;
  useEffect(() => {
    setScrollPosition(activeUsesOfflineScroll && activeTargetKey
      ? offlineBackendRef.current.snapshot(activeTargetKey).scroll
      : activeRemoteScroll);
  }, [activeRemoteScroll, activeTargetKey, activeUsesOfflineScroll]);

  const writeInput = async (
    data: string,
    target: TerminalRenderTarget | null = activeTargetRef.current,
    refocusTerminal = true,
  ): Promise<boolean> => {
    if (!target) return false;
    if (target.session.status !== 'connected') {
      return target.key === activeTargetRef.current?.key
        ? Boolean(renderer.current?.input(data))
        : false;
    }
    const inputTrace = beginTerminalInputTrace(
      target.key,
      data.includes('\r') || data.includes('\n') ? 'submit' : 'input',
    );
    onInteraction?.(target);
    setScrollPosition(current => current ? { ...current, offset_from_bottom: 0 } : current);
    try {
      const write = inputTrace
        ? target.client.writeToTerminal(target.session.terminalId, data, inputTrace)
        : target.client.writeToTerminal(target.session.terminalId, data);
      endTerminalWriteTrace(inputTrace, true);
      await write;
      if (target.key === activeTargetRef.current?.key) setError(null);
      if (
        refocusTerminal
        && target.key === activeTargetRef.current?.key
        && keyboardEnabled
        && keyboardVisible
      ) {
        renderer.current?.focus();
      }
      return true;
    } catch (reason) {
      endTerminalWriteTrace(inputTrace, false);
      if (target.key === activeTargetRef.current?.key) setError(String(reason));
      return false;
    }
  };

  const sendInput = async (
    data: string,
    target: TerminalRenderTarget | null = activeTargetRef.current,
  ) => {
    if (!target) return false;
    if (target.key !== activeTargetRef.current?.key) return writeInput(data, target, false);
    const value = applyTerminalModifiers(
      data,
      ctrlRef.current,
      altRef.current,
      shiftRef.current,
      protocolState.kittyKeyboardReportAll,
    );
    if (ctrlRef.current === 'armed') setCtrl('off');
    if (shiftRef.current === 'armed') setShift('off');
    if (altRef.current === 'armed') setAlt('off');
    return writeInput(value, target);
  };

  const handleVolumeKey = useEffectEvent((key: TerminalVolumeKey) => {
    if (!visible || !session) return;
    const configured = key === 'up' ? preferences.volumeUpAction : preferences.volumeDownAction;
    const action = resolveTerminalVolumeKeyAction(configured, key);
    if (!action || action.type === 'terminal-tab') return;
    if (action.type === 'font-size') {
      renderer.current?.changeFontSize(action.delta);
    } else if (action.type === 'scroll') {
      renderer.current?.scroll(action.direction, 1);
    } else {
      sendInput(action.data);
    }
  });

  useEffect(() => {
    const subscription = addTerminalVolumeKeyListener(handleVolumeKey);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!ready) {
      wasVisible.current = visible;
      return;
    }
    if (!visible) {
      if (wasVisible.current) renderer.current?.blur();
      wasVisible.current = false;
      return;
    }
    const enteredVisibility = !wasVisible.current;
    wasVisible.current = true;
    if (enteredVisibility && !composeOpen) {
      renderer.current?.blur();
      Keyboard.dismiss();
    }
    const timer = setTimeout(() => {
      renderer.current?.fit();
    }, 40);
    return () => clearTimeout(timer);
  }, [composeOpen, ready, visible]);

  useEffect(() => {
    if (status === 'connected' || composeOpen || !keyboardEnabled) return;
    setKeyboardEnabled(false);
    renderer.current?.setKeyboardEnabled(false);
    renderer.current?.blur();
    Keyboard.dismiss();
  }, [composeOpen, keyboardEnabled, status]);

  useEffect(() => {
    if (!ready) return;
    renderer.current?.setKeyboardEnabled(directKeyboardEnabled);
    if (!directKeyboardEnabled && !composerKeyboardEnabled) {
      Keyboard.dismiss();
    }
  }, [activeTarget?.key, composerKeyboardEnabled, directKeyboardEnabled, ready]);

  useEffect(() => {
    const dismissFocusedInput = () => {
      renderer.current?.blur();
      composeInputRef.current?.blur();
      Keyboard.dismiss();
    };
    const subscription = AppState.addEventListener('change', dismissFocusedInput);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!linkScanRequest || !ready || !visible) return;
    renderer.current?.scanLinks();
  }, [linkScanRequest, ready, visible]);

  useEffect(() => {
    if (!pasteRequest || !ready || !visible || pasteRequest.id <= handledPasteRequest.current) return;
    handledPasteRequest.current = pasteRequest.id;
    // Attachment requests always include previewUri; null identifies a
    // non-image attachment that must still remain a distinct paste event.
    if (composeOpen && pasteRequest.previewUri !== undefined) {
      const attachment = {
        id: pasteRequest.id,
        remotePath: pasteRequest.text,
        previewUri: pasteRequest.previewUri || null,
        dispose: pasteRequest.dispose || (() => {}),
      };
      composeAttachmentsRef.current = [...composeAttachmentsRef.current, attachment];
      if (activeTargetRef.current) {
        composeAttachmentsByTargetRef.current.set(
          activeTargetRef.current.key,
          composeAttachmentsRef.current,
        );
      }
      setComposeAttachments(composeAttachmentsRef.current);
      return;
    }
    if (composeOpen) {
      const current = composeTextRef.current;
      const next = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${pasteRequest.text}`;
      composeTextRef.current = next;
      setComposeText(next);
      onComposerDraftChange(terminalId, next);
      composeInputRef.current?.setNativeProps({ text: next });
      composeInputRef.current?.setSelection(next.length, next.length);
      pasteRequest.dispose?.();
      return;
    }
    renderer.current?.paste(pasteRequest.text);
    onHistoryEntry(pasteRequest.text);
    pasteRequest.dispose?.();
  }, [composeOpen, onComposerDraftChange, onHistoryEntry, pasteRequest, ready, terminalId, visible]);

  const publishQueuedMessages = useCallback((
    targetKey: string,
    messages: QueuedComposerMessage[],
  ) => {
    if (messages.length) queuedMessagesByTargetRef.current.set(targetKey, messages);
    else queuedMessagesByTargetRef.current.delete(targetKey);
    if (activeTargetRef.current?.key === targetKey) setQueuedMessages(messages);
  }, []);

  const scheduleQueuedRetry = useCallback((targetKey: string, attempts: number) => {
    if (queueRetryTimersRef.current.has(targetKey)) return;
    const delayMs = Math.min(8000, 750 * (2 ** Math.max(0, attempts - 1)));
    const timer = setTimeout(() => {
      queueRetryTimersRef.current.delete(targetKey);
      const target = targetsRef.current.find(item => item.key === targetKey);
      if (target) flushQueuedTargetRef.current(target);
    }, delayMs);
    queueRetryTimersRef.current.set(targetKey, timer);
  }, []);

  const flushQueuedTarget = useCallback(async (target: TerminalRenderTarget) => {
    const targetKey = target.key;
    if (target.session.status !== 'connected' || queueFlushesRef.current.has(targetKey)) return;
    const terminalRenderer = renderer.current;
    if (!terminalRenderer) return;
    const retryTimer = queueRetryTimersRef.current.get(targetKey);
    if (retryTimer) clearTimeout(retryTimer);
    queueRetryTimersRef.current.delete(targetKey);
    queueFlushesRef.current.add(targetKey);
    try {
      while (true) {
        const message = queuedMessagesByTargetRef.current.get(targetKey)?.[0];
        if (!message) return;
        const sendingMessage = { ...message, sending: true, error: null };
        const sendingQueue = [
          sendingMessage,
          ...(queuedMessagesByTargetRef.current.get(targetKey)?.slice(1) || []),
        ];
        publishQueuedMessages(targetKey, sendingQueue);
        try {
          await terminalRenderer.submitPastes(target, message.pasteEvents);
          if (target.key === activeTargetRef.current?.key) setError(null);
        } catch (reason) {
          const current = queuedMessagesByTargetRef.current.get(targetKey) || [];
          const failed = current.map(item => item.id === message.id
            ? {
                ...item,
                sending: false,
                attempts: item.attempts + 1,
                error: String(reason),
              }
            : item);
          publishQueuedMessages(targetKey, failed);
          scheduleQueuedRetry(targetKey, message.attempts + 1);
          return;
        }
        const current = queuedMessagesByTargetRef.current.get(targetKey) || [];
        if (current.some(item => item.id === message.id)) {
          publishQueuedMessages(targetKey, current.filter(item => item.id !== message.id));
          for (const attachment of message.attachments) attachment.dispose();
          onHistoryEntry(message.historyEntry);
        }
      }
    } finally {
      queueFlushesRef.current.delete(targetKey);
    }
  }, [onHistoryEntry, publishQueuedMessages, scheduleQueuedRetry]);
  flushQueuedTargetRef.current = target => {
    flushQueuedTarget(target).catch(() => undefined);
  };

  useEffect(() => {
    for (const target of targets) {
      if (
        target.session.status === 'connected'
        && queuedMessagesByTargetRef.current.has(target.key)
      ) {
        flushQueuedTargetRef.current(target);
      }
    }
  }, [targets]);

  useEffect(() => () => {
    for (const attachments of composeAttachmentsByTargetRef.current.values()) {
      for (const attachment of attachments) attachment.dispose();
    }
    composeAttachmentsByTargetRef.current.clear();
    for (const messages of queuedMessagesByTargetRef.current.values()) {
      for (const message of messages) {
        for (const attachment of message.attachments) attachment.dispose();
      }
    }
    queuedMessagesByTargetRef.current.clear();
    for (const timer of queueRetryTimersRef.current.values()) clearTimeout(timer);
    queueRetryTimersRef.current.clear();
    composeAttachmentsRef.current = [];
  }, []);

  useEffect(() => {
    const targetKeys = new Set(targets.map(target => target.key));
    for (const [key, attachments] of composeAttachmentsByTargetRef.current) {
      if (targetKeys.has(key)) continue;
      for (const attachment of attachments) attachment.dispose();
      composeAttachmentsByTargetRef.current.delete(key);
    }
    for (const [key, messages] of queuedMessagesByTargetRef.current) {
      if (targetKeys.has(key)) continue;
      for (const message of messages) {
        for (const attachment of message.attachments) attachment.dispose();
      }
      queuedMessagesByTargetRef.current.delete(key);
      const timer = queueRetryTimersRef.current.get(key);
      if (timer) clearTimeout(timer);
      queueRetryTimersRef.current.delete(key);
    }
  }, [targets]);

  useEffect(() => {
    if (!visible) {
      if (composeOpen) setComposeOpen(false);
      setComposeExpanded(false);
      setHistoryOpen(false);
    }
    setTerminalComposerOverlay(terminalId, visible && composeOpen).catch(() => {});
  }, [composeOpen, terminalId, visible]);

  useEffect(() => () => {
    setTerminalComposerOverlay(terminalId, false).catch(() => {});
  }, [terminalId]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      renderer.current?.fit();
    }, 40);
    return () => clearTimeout(timer);
  }, [composeOpen, keyboardInset, ready]);

  useEffect(() => {
    if (!composeOpen || composeExpanded || !keyboardEnabled) return;
    const timer = setTimeout(() => {
      composeInputRef.current?.focus();
    }, Platform.OS === 'ios' ? 100 : 40);
    return () => clearTimeout(timer);
  }, [composeExpanded, composeOpen, keyboardEnabled]);

  useEffect(() => {
    if (!ready) return;
    if (!searchOpen) {
      renderer.current?.clearSearch();
      return;
    }
    renderer.current?.search(searchQuery, searchCase, searchRegex, 0);
  }, [ready, searchCase, searchOpen, searchQuery, searchRegex]);

  const pasteClipboard = async () => {
    const value = await Clipboard.getString();
    if (!value) return;
    renderer.current?.paste(value);
    onHistoryEntry(value);
  };

  const moveSearch = (direction: -1 | 1) => {
    renderer.current?.search(searchQuery, searchCase, searchRegex, direction);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    if (keyboardEnabled) setTimeout(() => renderer.current?.focus(), 40);
  };

  const closeComposerKeyboard = async () => {
    composeInputRef.current?.blur();
    renderer.current?.blur();
    if (!keyboardVisible) {
      Keyboard.dismiss();
      return;
    }

    await new Promise<void>(resolve => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const subscription = Keyboard.addListener('keyboardDidHide', () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        subscription.remove();
        resolve();
      });
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        subscription.remove();
        resolve();
      }, 1000);
      Keyboard.dismiss();
    });
  };

  const retryNow = () => {
    renderer.current?.retry();
  };

  const closeCompose = async () => {
    await closeComposerKeyboard();
    setComposeExpanded(false);
    setComposeOpen(false);
    await setTerminalComposerOverlay(terminalId, false).catch(reason => setError(String(reason)));
  };

  const openCompose = () => {
    setSearchOpen(false);
    setHistoryOpen(false);
    setTerminalComposerOverlay(terminalId, true).catch(reason => setError(String(reason))).finally(() => {
      setKeyboardEnabled(true);
      setComposeOpen(true);
    });
  };

  const expandCompose = () => {
    renderer.current?.blur();
    setKeyboardEnabled(true);
    setComposeExpanded(true);
  };

  const collapseCompose = () => {
    setComposeExpanded(false);
    if (keyboardEnabled) setTimeout(() => composeInputRef.current?.focus(), 80);
  };

  const submitCompose = () => {
    const target = activeTargetRef.current;
    if (target) onInteraction?.(target);
    const attachmentPaths = composeAttachmentsRef.current.map(attachment => attachment.remotePath);
    const submission = composeTerminalSubmission(composeTextRef.current, attachmentPaths);
    if (!submission.historyEntry) {
      sendInput(ENTER_INPUT);
      return;
    }
    if (!target) return;
    const message: QueuedComposerMessage = {
      id: ++queuedMessageSequenceRef.current,
      text: composeTextRef.current,
      pasteEvents: submission.pasteEvents,
      historyEntry: submission.historyEntry,
      attachments: composeAttachmentsRef.current,
      sending: false,
      attempts: 0,
      error: null,
    };
    publishQueuedMessages(target.key, [
      ...(queuedMessagesByTargetRef.current.get(target.key) || []),
      message,
    ]);
    composeTextRef.current = '';
    setComposeText('');
    if (terminalId) onComposerDraftChange(terminalId, '');
    composeInputRef.current?.clear();
    composeAttachmentsByTargetRef.current.delete(target.key);
    composeAttachmentsRef.current = [];
    setComposeAttachments([]);
    flushQueuedTargetRef.current(target);
  };

  const unqueueComposeMessage = (id: number) => {
    const target = activeTargetRef.current;
    if (!target) return;
    const queue = queuedMessagesByTargetRef.current.get(target.key) || [];
    const message = queue.find(item => item.id === id);
    if (!message || message.sending) return;
    const remaining = queue.filter(item => item.id !== id);
    publishQueuedMessages(target.key, remaining);
    if (!remaining.length) {
      const retryTimer = queueRetryTimersRef.current.get(target.key);
      if (retryTimer) clearTimeout(retryTimer);
      queueRetryTimersRef.current.delete(target.key);
    }
    const currentText = composeTextRef.current;
    const nextText = [message.text, currentText].filter(Boolean).join('\n');
    composeTextRef.current = nextText;
    setComposeText(nextText);
    onComposerDraftChange(target.session.terminalId, nextText);
    composeInputRef.current?.setNativeProps({ text: nextText });
    composeInputRef.current?.setSelection(nextText.length, nextText.length);
    composeAttachmentsRef.current = [
      ...message.attachments,
      ...composeAttachmentsRef.current,
    ];
    if (composeAttachmentsRef.current.length) {
      composeAttachmentsByTargetRef.current.set(target.key, composeAttachmentsRef.current);
    }
    setComposeAttachments(composeAttachmentsRef.current);
  };

  const selectHistoryEntry = (entry: string) => {
    renderer.current?.paste(entry);
    onHistoryEntry(entry);
    setHistoryOpen(false);
  };

  const removeComposeAttachment = (id: number) => {
    const attachment = composeAttachmentsRef.current.find(item => item.id === id);
    attachment?.dispose();
    composeAttachmentsRef.current = composeAttachmentsRef.current.filter(item => item.id !== id);
    if (activeTargetRef.current) {
      if (composeAttachmentsRef.current.length) {
        composeAttachmentsByTargetRef.current.set(
          activeTargetRef.current.key,
          composeAttachmentsRef.current,
        );
      } else {
        composeAttachmentsByTargetRef.current.delete(activeTargetRef.current.key);
      }
    }
    setComposeAttachments(composeAttachmentsRef.current);
  };

  const updateComposeText = (value: string) => {
    if (activeTargetRef.current) onInteraction?.(activeTargetRef.current);
    composeTextRef.current = value;
    setComposeText(value);
    if (terminalId) onComposerDraftChange(terminalId, value);
  };

  const renderTerminalControl = (control: TerminalControlId) => {
    const key = TERMINAL_KEYS[control];
    if (key) {
      const fixedIcon = TERMINAL_KEY_ICONS[control];
      const iconicKey = ICONIC_TERMINAL_KEYS[control];
      const useIconicKey = preferences.useModifierKeyIcons && Boolean(iconicKey);
      const icon = fixedIcon?.icon ?? (useIconicKey ? iconicKey?.icon : undefined);
      return (
        <TerminalKey
          key={control}
          label={useIconicKey && iconicKey?.label ? iconicKey.label : key[0]}
          icon={icon}
          accessibilityLabel={fixedIcon ? t(fixedIcon.accessibilityKey) : iconicKey ? t(iconicKey.accessibilityKey) : undefined}
          symbolic={!icon && (useIconicKey || key[2] === 'symbol')}
          onPress={() => {
            onControlUse(control);
            sendInput(key[1]);
          }}
        />
      );
    }
    if (control === 'keyboard') {
      return (
        <Button
          key={control}
          accessibilityLabel={keyboardControlSelected ? t('terminal.disableKeyboard') : t('terminal.enableKeyboard')}
          accessibilityState={{ disabled: keyboardControlDisabled, selected: keyboardControlSelected }}
          className={cn(TERMINAL_ICON_CONTROL_CLASS, keyboardControlSelected && 'border-primary bg-primary/15')}
          disabled={keyboardControlDisabled}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            const enabled = !keyboardEnabled;
            if (enabled && status === 'connected' && !composeOpen) {
              renderer.current?.setKeyboardEnabled(true);
            }
            setKeyboardEnabled(enabled);
            if (enabled) {
              setTimeout(() => {
                if (composeOpen) {
                  composeInputRef.current?.focus();
                } else if (status === 'connected') {
                  renderer.current?.focus();
                }
              }, 40);
            } else {
              Keyboard.dismiss();
              renderer.current?.blur();
            }
          }}>
          <View className={TERMINAL_ICON_BOX_CLASS}>
            <KeyboardIcon size={TERMINAL_ICON_SIZE} color={keyboardControlSelected ? appColors.primary : appColors.text} />
          </View>
        </Button>
      );
    }
    if (control === 'paste') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.paste')}
          className={TERMINAL_ICON_CONTROL_CLASS}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            pasteClipboard().catch(reason => setError(String(reason)));
          }}>
          <View className={TERMINAL_ICON_BOX_CLASS}>
            <ClipboardPaste size={TERMINAL_ICON_SIZE} color={appColors.text} />
          </View>
        </Button>
      );
    }
    if (control === 'history') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.history')}
          accessibilityState={{ expanded: historyOpen }}
          className={cn(TERMINAL_ICON_CONTROL_CLASS, historyOpen && 'border-primary')}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            if (historyOpen) {
              setHistoryOpen(false);
            } else if (composeOpen) {
              closeCompose().finally(() => setHistoryOpen(true));
            } else {
              setSearchOpen(false);
              setHistoryOpen(true);
            }
          }}>
          <View className={TERMINAL_ICON_BOX_CLASS}>
            <History size={TERMINAL_ICON_SIZE} color={historyOpen ? appColors.primary : appColors.text} />
          </View>
        </Button>
      );
    }
    if (control === 'compose') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.compose')}
          accessibilityState={{ selected: composeOpen }}
          className={cn(TERMINAL_ICON_CONTROL_CLASS, composeOpen && 'border-primary')}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            if (composeOpen) closeCompose();
            else openCompose();
          }}>
          <View className={TERMINAL_ICON_BOX_CLASS}>
            <MessageCircle size={TERMINAL_ICON_SIZE} color={appColors.text} />
          </View>
        </Button>
      );
    }
    if (control === 'attach') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.attach')}
          className={TERMINAL_ICON_CONTROL_CLASS}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            onRequestAttachment?.();
          }}>
          <View className={TERMINAL_ICON_BOX_CLASS}>
            <Paperclip size={TERMINAL_ICON_SIZE} color={appColors.text} />
          </View>
        </Button>
      );
    }
    if (control === 'files') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.openFiles')}
          className={TERMINAL_ICON_CONTROL_CLASS}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            onRequestFiles?.();
          }}>
          <View className={TERMINAL_ICON_BOX_CLASS}>
            <FolderOpen size={TERMINAL_ICON_SIZE} color={appColors.text} />
          </View>
        </Button>
      );
    }
    if (control === 'find') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.find')}
          accessibilityState={{ selected: searchOpen }}
          className={cn(TERMINAL_ICON_CONTROL_CLASS, searchOpen && 'border-primary')}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            setHistoryOpen(false);
            if (composeOpen) {
              closeCompose().finally(() => {
                setSearchOpen(true);
              });
            } else {
              setSearchOpen(value => !value);
            }
          }}>
          <View className={TERMINAL_ICON_BOX_CLASS}>
            <Search size={TERMINAL_ICON_SIZE} color={searchOpen ? appColors.primary : appColors.text} />
          </View>
        </Button>
      );
    }
    const modifier = control === 'ctrl'
      ? { value: ctrl, setValue: setCtrl, icon: ChevronUp, label: 'CTRL', accessibilityKey: 'terminal.ctrlModifier' }
      : control === 'shift'
        ? { value: shift, setValue: setShift, icon: ArrowBigUp, label: 'SHIFT', accessibilityKey: 'terminal.shiftModifier' }
        : control === 'alt'
          ? { value: alt, setValue: setAlt, icon: Option, label: 'ALT', accessibilityKey: 'terminal.altModifier' }
          : null;
    if (!modifier) return null;
    const modifierClassName = cn(
      modifier.value === 'armed' && 'text-primary',
      modifier.value === 'locked' && 'text-primary-foreground',
    );
    return (
      <Button
        key={control}
        accessibilityLabel={t(modifier.accessibilityKey)}
        accessibilityState={{ selected: modifier.value !== 'off' }}
        className={cn(
          preferences.useModifierKeyIcons ? TERMINAL_ICON_CONTROL_CLASS : TERMINAL_TEXT_CONTROL_CLASS,
          modifier.value === 'armed' && 'border-primary',
          modifier.value === 'locked' && 'border-primary bg-primary/70 active:bg-primary/80',
        )}
        delayLongPress={450}
        variant="secondary"
        onLongPress={() => modifier.setValue('locked')}
        onPress={() => {
          onControlUse(control);
          modifier.setValue(value => value === 'off' ? 'armed' : 'off');
        }}>
        {preferences.useModifierKeyIcons ? (
          <TerminalControlIcon icon={modifier.icon} className={modifierClassName} />
        ) : (
          <TerminalControlLabel label={modifier.label} className={modifierClassName} />
        )}
      </Button>
    );
  };

  return (
    <View
      accessibilityElementsHidden={!visible || !session}
      importantForAccessibility={visible && session ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible && session ? 'auto' : 'none'}
      shouldRasterizeIOS={Platform.OS === 'ios'}
      className={cn(
        'flex-1 bg-transparent',
        !visible && session && 'absolute inset-0',
        !session && 'absolute inset-0 opacity-0',
      )}>
      {!compact && <TerminalBackground preferences={preferences} />}
      {!compact && (
        <View className="h-[30px] flex-row items-center gap-2 border-b border-terminal-divider bg-terminal-panel px-3">
          <View className="size-1.5 rounded-full bg-white" />
          <Text numberOfLines={1} className="flex-1 text-[9px] tracking-[1px] text-terminal-muted">
            {t('terminal.agentTitle', { title, terminalId })}
          </Text>
          {error && <Text className="text-[8px] text-terminal-error">{t('terminal.attachFailed')}</Text>}
        </View>
      )}
      {searchOpen && (
        <View
          className="min-h-12 flex-row items-center gap-1 border-b border-terminal-divider bg-terminal-surface px-[7px]"
          style={topOverlayInset > 0 ? { marginTop: topOverlayInset } : undefined}>
          <Input
            autoFocus
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={() => moveSearch(1)}
            placeholder={t('terminal.findPlaceholder')}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            className="h-9 min-w-[100px] flex-1 rounded-full border-0 bg-terminal-canvas px-3 font-mono text-[10px] text-terminal-text shadow-none"
          />
          <Button className={cn('size-8 rounded-full px-0', searchCase && 'bg-terminal-accent')} variant="ghost" onPress={() => setSearchCase(value => !value)}><Text className={cn('font-mono text-[9px] font-extrabold text-terminal-muted', searchCase && 'text-terminal-ink')}>Aa</Text></Button>
          <Button className={cn('size-8 rounded-full px-0', searchRegex && 'bg-terminal-accent')} variant="ghost" onPress={() => setSearchRegex(value => !value)}><Text className={cn('font-mono text-[9px] font-extrabold text-terminal-muted', searchRegex && 'text-terminal-ink')}>.*</Text></Button>
          <Text className={cn('min-w-[34px] text-center font-mono text-[8px] text-terminal-muted', (searchResult.invalid || (searchQuery && searchResult.count === 0)) && 'text-terminal-error')}>
            {searchResult.invalid ? 'ERR' : searchQuery ? `${Math.max(0, searchResult.index + 1)}/${searchResult.count}` : ''}
          </Text>
          <Button accessibilityLabel={t('terminal.previousResult')} className="h-[31px] w-7 rounded-none px-0" disabled={!searchResult.count} variant="ghost" onPress={() => moveSearch(-1)}><ChevronUp size={16} color={colors.text} /></Button>
          <Button accessibilityLabel={t('terminal.nextResult')} className="h-[31px] w-7 rounded-none px-0" disabled={!searchResult.count} variant="ghost" onPress={() => moveSearch(1)}><ChevronDown size={16} color={colors.text} /></Button>
          <Button accessibilityLabel={t('terminal.closeSearch')} className="h-[31px] w-7 rounded-none px-0" variant="ghost" onPress={closeSearch}><X size={17} color={colors.text} /></Button>
        </View>
      )}
      <View
        pointerEvents={composeOpen ? 'none' : 'auto'}
        className="relative flex-1"
        style={keyboardInset > 0 && !composeOpen ? { paddingBottom: keyboardInset } : undefined}
        {...(!terminalSelectionActive ? terminalPanHandlers : undefined)}
      >
        <TerminalRendererHost
          ref={renderer}
          activeTarget={activeTarget}
          previewTarget={previewTarget}
          targets={targets}
          visible={visible}
          preferences={preferences}
          offlineTranscript={offlineSnapshot.transcript}
          offlineScroll={offlineSnapshot.scroll}
          swipe={swipe}
          onReady={() => setReady(true)}
          onInput={async (target, data) => {
            await sendInput(data, target);
          }}
          onScroll={(target, direction, lines) => {
            if (target.key === activeTarget?.key) {
              setScrollPosition(current => moveTerminalScroll(current, direction, lines));
            }
          }}
          onOfflineScroll={(target, scroll) => {
            const next = offlineBackendRef.current.updateScroll(target.key, scroll);
            if (target.key === activeTarget?.key) {
              setOfflineBackendRevision(value => value + 1);
              setScrollPosition(next.scroll);
            }
          }}
          onSearchResult={(count, index, invalid) => setSearchResult({ count, index, invalid })}
          onLinksScanned={links => onLinksScanned?.(links)}
          onOpenLink={link => onOpenLink?.(link)}
          onPaste={(_target, text) => onHistoryEntry(text)}
          onBufferModeChange={(target, alternate) => {
            if (target.key !== activeTarget?.key) return;
            setAlternateScreen(alternate);
            setTerminalSelectionActive(false);
            setSearchResult({ count: 0, index: -1, invalid: false });
          }}
          onProtocolStateChange={(target, state) => {
            if (target.key === activeTarget?.key) setProtocolState(state);
          }}
          onTitleChange={(target, nextTitle) => {
            if (target.key === activeTarget?.key) setReportedTitle(nextTitle);
          }}
          onSelectionStateChange={(target, active) => {
            if (target.key === activeTarget?.key) setTerminalSelectionActive(active);
          }}
          onStatus={(target, nextStatus, nextError, reconnectAttempt) => {
            if (nextStatus === 'connected' && target.key === activeTargetRef.current?.key) {
              setError(null);
            }
            onStatus(target, nextStatus, nextError, reconnectAttempt);
          }}
          onError={(target, message) => {
            if (target.key === activeTarget?.key) setError(message);
          }}
          style={WEBVIEW_STYLE}
        />
        {scrollThumb && (
          <View
            accessibilityElementsHidden
            pointerEvents="none"
            className="absolute inset-y-0 right-0.5 w-0.5">
            <View
              className="absolute inset-x-0 rounded-full bg-terminal-text/70"
              style={{ height: `${scrollThumb.heightPercent}%`, top: `${scrollThumb.topPercent}%` }}
            />
          </View>
        )}
      </View>
      {session && status !== 'connected' && (
        <View
          pointerEvents="box-none"
          className="absolute inset-x-2 z-20"
          style={{ top: topOverlayInset + 8 }}>
          <View className="flex-row items-center gap-2 rounded-lg border border-terminal-divider bg-terminal-panel/95 p-2 shadow-lg">
            <View className={cn('size-2 rounded-full bg-terminal-success', status === 'error' && 'bg-terminal-error')} />
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[12px] font-semibold text-terminal-text">
                {status === 'connecting' ? t('terminal.connecting') : status === 'disconnected' ? t('terminal.reconnecting') : t('terminal.failed')}
              </Text>
              <Text numberOfLines={1} className="text-[9px] text-terminal-muted">
                {status === 'disconnected' && session.reconnectAttempt > 0
                  ? t('terminal.attempt', { attempt: session.reconnectAttempt, total: MAX_RECONNECT_ATTEMPTS })
                  : session.error || error || t('terminal.opening', { title })}
              </Text>
            </View>
            {status !== 'connecting' && (
              <Button className="h-8 rounded-full bg-terminal-accent px-3" onPress={retryNow}><Text className="text-[10px] font-semibold text-terminal-ink">{t('terminal.retry')}</Text></Button>
            )}
            <Button accessibilityLabel={t('terminal.closeSession')} className="size-8 rounded-full px-0" variant="ghost" onPress={onClose}><X size={16} color={colors.text} /></Button>
          </View>
        </View>
      )}
      {composeOpen && !composeExpanded && (
        <Portal name={`terminal-composer-${terminalId}`}>
          <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            <View
              className="absolute inset-x-0 border-t border-terminal-divider bg-transparent p-2"
              style={{
                bottom: TERMINAL_CONTROL_BAR_HEIGHT + bottomSafeAreaInset + keyboardInset,
              }}>
              <View className="flex-row items-end gap-2">
                <View className="gap-1.5">
                  <Button
                    accessibilityLabel={t('terminal.attach')}
                    className="size-10 rounded-full bg-terminal-surface px-0"
                    variant="secondary"
                    onPress={onRequestAttachment}>
                    <Paperclip size={18} color={colors.text} />
                  </Button>
                  <Button
                    accessibilityLabel={t('terminal.expandComposer')}
                    className="size-10 rounded-full bg-terminal-surface px-0"
                    variant="secondary"
                    onPress={expandCompose}>
                    <Maximize2 size={17} color={colors.text} />
                  </Button>
                </View>
                <View className="min-w-0 flex-1 overflow-hidden rounded-lg border border-terminal-divider bg-terminal-canvas">
                  <QueuedMessagesStrip
                    messages={queuedMessages}
                    label={t('terminal.outbox')}
                    queuedLabel={t('terminal.queued')}
                    sendingLabel={t('terminal.sending')}
                    unqueueLabel={t('terminal.unqueue')}
                    onUnqueue={unqueueComposeMessage}
                  />
                  <ComposeAttachmentsStrip
                    attachments={composeAttachments}
                    removeLabel={t('terminal.removeAttachment')}
                    onRemove={removeComposeAttachment}
                  />
                  <ComposerInput
                    ref={composeInputRef}
                    initialValue={composeText}
                    autoFocus={keyboardEnabled}
                    showSoftInputOnFocus={keyboardEnabled}
                    multiline
                    numberOfLines={3}
                    textAlignVertical="top"
                    onChangeText={updateComposeText}
                    placeholder={t('terminal.composePlaceholder')}
                    placeholderTextColor={colors.muted}
                    className="h-[76px] rounded-none border-0 bg-transparent px-3 py-2 font-mono text-[12px] leading-[17px] text-terminal-text"
                  />
                </View>
                <View className="gap-1.5">
                  <Button
                    accessibilityLabel={t('terminal.sendBufferedInput')}
                    className="size-10 rounded-full bg-white px-0"
                    onPress={submitCompose}>
                    <Send size={17} color={colors.ink} />
                  </Button>
                  <Button
                    accessibilityLabel={t('terminal.closeCompose')}
                    className="size-10 rounded-full bg-terminal-surface px-0"
                    variant="secondary"
                    onPress={closeCompose}>
                    <X size={17} color={colors.text} />
                  </Button>
                </View>
              </View>
            </View>
          </View>
        </Portal>
      )}
      <View
        ref={controlsRef}
        collapsable={false}
        className="relative z-10"
        style={keyboardInset > 0 ? { transform: [{ translateY: -keyboardInset }] } : undefined}>
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          className="flex-grow-0"
          contentContainerClassName="items-center gap-[5px] px-1.5 pt-[7px]"
          contentContainerStyle={{ paddingBottom: 7 + bottomSafeAreaInset }}>
          {controlOrder.map(renderTerminalControl)}
        </ScrollView>
      </View>
      {composeOpen && composeExpanded && (
        <Modal
          animationType="slide"
          onRequestClose={collapseCompose}
          onShow={() => {
            setTimeout(() => composeInputRef.current?.focus(), 40);
          }}
          statusBarTranslucent
          visible>
          <View
            className="flex-1 bg-terminal-canvas"
            style={{
              paddingTop: topSafeAreaInset,
              paddingBottom: Math.max(bottomSafeAreaInset, keyboardInset),
            }}>
            <View className="h-14 flex-row items-center gap-2 border-b border-terminal-divider bg-terminal-panel px-2">
              <Button
                accessibilityLabel={t('terminal.collapseComposer')}
                className="size-10 rounded-full px-0"
                variant="ghost"
                onPress={collapseCompose}>
                <Minimize2 size={19} color={colors.text} />
              </Button>
              <View className="min-w-0 flex-1">
                <Text className="font-mono text-[13px] font-bold text-terminal-text">
                  {t('terminal.expandedComposerTitle')}
                </Text>
                <Text numberOfLines={1} className="font-mono text-[9px] text-terminal-muted">
                  {title}
                </Text>
              </View>
              <Button
                accessibilityLabel={t('terminal.sendBufferedInput')}
                className="h-10 flex-row gap-2 rounded-full bg-white px-4"
                onPress={submitCompose}>
                <Send size={16} color={colors.ink} />
                <Text className="font-mono text-[11px] font-bold text-terminal-ink">SEND</Text>
              </Button>
            </View>
            <QueuedMessagesStrip
              messages={queuedMessages}
              label={t('terminal.outbox')}
              queuedLabel={t('terminal.queued')}
              sendingLabel={t('terminal.sending')}
              unqueueLabel={t('terminal.unqueue')}
              onUnqueue={unqueueComposeMessage}
              expanded
            />
            <ComposeAttachmentsStrip
              attachments={composeAttachments}
              removeLabel={t('terminal.removeAttachment')}
              onRemove={removeComposeAttachment}
              expanded
            />
            <ComposerInput
              ref={composeInputRef}
              initialValue={composeText}
              autoFocus={keyboardEnabled}
              showSoftInputOnFocus={keyboardEnabled}
              multiline
              textAlignVertical="top"
              onChangeText={updateComposeText}
              placeholder={t('terminal.composePlaceholder')}
              placeholderTextColor={colors.muted}
              className="h-auto min-h-0 flex-1 rounded-none border-0 bg-transparent px-4 py-4 font-mono text-[15px] leading-[22px] text-terminal-text shadow-none"
            />
            <View className="h-14 flex-row items-center border-t border-terminal-divider bg-terminal-panel px-2">
              <Button
                accessibilityLabel={t('terminal.attach')}
                className="size-10 rounded-full px-0"
                variant="ghost"
                onPress={onRequestAttachment}>
                <Paperclip size={19} color={colors.text} />
              </Button>
              <Text className="ml-auto px-2 font-mono text-[9px] text-terminal-muted">
                {t('terminal.composeCharacterCount', { count: composeText.length.toLocaleString() })}
              </Text>
            </View>
          </View>
        </Modal>
      )}
      <Modal
        animationType="fade"
        onRequestClose={() => setHistoryOpen(false)}
        statusBarTranslucent
        transparent
        visible={historyOpen}>
        <View className="flex-1 justify-end bg-black/50">
          <Pressable
            accessibilityLabel={t('terminal.closeHistory')}
            className="flex-1"
            onPress={() => setHistoryOpen(false)}
          />
          <View
            className="rounded-t-3xl bg-background px-4 pt-3"
            style={{ paddingBottom: Math.max(16, bottomSafeAreaInset) }}>
            <View className="mb-2 flex-row items-center">
              <View className="size-10 items-center justify-center rounded-full bg-muted">
                <History size={18} color={appColors.text} />
              </View>
              <View className="min-w-0 flex-1 px-3">
                <Text className="text-[17px] font-bold text-foreground">{t('terminal.historyTitle')}</Text>
                <Text className="text-[11px] text-muted-foreground">{t('terminal.historyCopy')}</Text>
              </View>
              <Button
                accessibilityLabel={t('terminal.closeHistory')}
                className="size-10 rounded-full px-0"
                variant="ghost"
                onPress={() => setHistoryOpen(false)}>
                <X size={19} color={appColors.text} />
              </Button>
            </View>
            {historyEntries.length === 0 ? (
              <View className="h-32 items-center justify-center px-6">
                <Text className="text-center text-[13px] text-muted-foreground">{t('terminal.historyEmpty')}</Text>
              </View>
            ) : (
              <ScrollView
                className="max-h-[420px]"
                keyboardShouldPersistTaps="always"
                showsVerticalScrollIndicator={false}>
                {historyEntries.map((entry, index) => (
                  <Button
                    key={entry}
                    accessibilityLabel={t('terminal.useHistoryEntry', { text: entry })}
                    className={cn('min-h-12 justify-start rounded-none px-2.5 py-2.5', index > 0 && 'border-t border-border')}
                    variant="ghost"
                    onPress={() => selectHistoryEntry(entry)}>
                    <Text
                      numberOfLines={3}
                      className="flex-1 text-left font-mono text-[14px] leading-5 text-foreground"
                      style={{ fontFamily: terminalFontFamily }}>
                      {entry}
                    </Text>
                  </Button>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

interface QueuedComposerMessage {
  id: number;
  text: string;
  pasteEvents: string[];
  historyEntry: string;
  attachments: ComposeAttachment[];
  sending: boolean;
  attempts: number;
  error: string | null;
}

function QueuedMessagesStrip({
  messages,
  label,
  queuedLabel,
  sendingLabel,
  unqueueLabel,
  onUnqueue,
  expanded = false,
}: {
  messages: readonly QueuedComposerMessage[];
  label: string;
  queuedLabel: string;
  sendingLabel: string;
  unqueueLabel: string;
  onUnqueue: (id: number) => void;
  expanded?: boolean;
}) {
  if (!messages.length) return null;
  return (
    <View className={cn(expanded ? 'border-b border-terminal-divider px-3 py-3' : 'border-b border-terminal-divider px-2 py-2')}>
      <Text className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-terminal-muted">
        {label} · {messages.length}
      </Text>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2">
        {messages.map(message => (
          <View
            key={message.id}
            className="h-12 w-56 flex-row items-center gap-2 rounded-md border border-terminal-divider bg-terminal-surface px-2">
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="font-mono text-[10px] text-terminal-text">
                {message.historyEntry}
              </Text>
              <Text className="font-mono text-[8px] text-terminal-muted">
                {message.sending ? sendingLabel : queuedLabel}
              </Text>
            </View>
            <Button
              accessibilityLabel={unqueueLabel}
              className="size-8 rounded-full px-0"
              disabled={message.sending}
              variant="ghost"
              onPress={() => onUnqueue(message.id)}>
              <Undo2 size={15} color={message.sending ? colors.muted : colors.text} />
            </Button>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

interface ComposeAttachment {
  id: number;
  remotePath: string;
  previewUri: string | null;
  dispose: () => void;
}

function ComposeAttachmentsStrip({
  attachments,
  expanded = false,
  removeLabel,
  onRemove,
}: {
  attachments: readonly ComposeAttachment[];
  expanded?: boolean;
  removeLabel: string;
  onRemove: (id: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      className={cn('flex-grow-0', expanded ? 'border-b border-terminal-divider px-3 py-3' : 'mx-2 mt-2')}
      contentContainerClassName="gap-2">
      {attachments.map(attachment => (
        <View key={attachment.id} className="relative size-16 overflow-hidden rounded-lg border border-terminal-divider bg-terminal-surface">
          {attachment.previewUri ? (
            <Image className="size-full" resizeMode="cover" source={{ uri: attachment.previewUri }} />
          ) : (
            <View className="size-full items-center justify-center">
              <Paperclip size={23} color={colors.muted} />
            </View>
          )}
          <Button
            accessibilityLabel={removeLabel}
            className="absolute right-0.5 top-0.5 size-6 rounded-full bg-black/75 px-0"
            onPress={() => onRemove(attachment.id)}>
            <X size={13} color="#fff" />
          </Button>
        </View>
      ))}
    </ScrollView>
  );
}

function TerminalKey({ label, icon, accessibilityLabel, symbolic = false, onPress }: { label: string; icon?: LucideIcon; accessibilityLabel?: string; symbolic?: boolean; onPress: () => void }) {
  return (
    <Button accessibilityLabel={accessibilityLabel} className={icon || symbolic ? TERMINAL_ICON_CONTROL_CLASS : TERMINAL_TEXT_CONTROL_CLASS} variant="secondary" onPress={onPress}>
      {icon ? <TerminalControlIcon icon={icon} /> : <TerminalControlLabel label={label} symbolic={symbolic} />}
    </Button>
  );
}

function TerminalControlIcon({ icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <View className={TERMINAL_ICON_BOX_CLASS}>
      <Icon as={icon} size={TERMINAL_ICON_SIZE} className={className} />
    </View>
  );
}

function TerminalControlLabel({ label, symbolic = false, className }: { label: string; symbolic?: boolean; className?: string }) {
  const text = (
    <Text
      allowFontScaling={false}
      numberOfLines={1}
      className={cn('text-center font-mono font-bold text-foreground', symbolic ? 'text-[18px] leading-5' : 'text-[12px] leading-4', className)}
      style={TERMINAL_CONTROL_LABEL_STYLE}>
      {label}
    </Text>
  );
  return symbolic ? (
    <View className={TERMINAL_ICON_BOX_CLASS}>
      {text}
    </View>
  ) : text;
}
