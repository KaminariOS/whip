import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Portal } from '@rn-primitives/portal';
import { ArrowBigUp, ArrowDown, ArrowLeft, ArrowRight, ArrowRightToLine, ArrowUp, ChevronDown, ChevronUp, ClipboardPaste, CornerDownLeft, FolderOpen, History, Keyboard as KeyboardIcon, Maximize2, MessageCircle, Minimize2, Option, Paperclip, Search, Send, X, type LucideIcon } from 'lucide-react-native';
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
import type { TerminalRenderTarget } from '../lib/terminalRenderer';
import type { TerminalProtocolState } from '../lib/terminalBridge';
import type { TerminalPreferences } from '../services/devicePreferences';
import { setTerminalComposerOverlay } from '../services/terminalSoftInput';
import { applyTerminalModifiers, type TerminalModifierState } from '../lib/terminalInput';
import { moveTerminalScroll, terminalScrollThumb } from '../lib/terminalScroll';
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
  swipe?: {
    direction: -1 | 1;
    offset: SharedValue<number>;
  } | null;
  terminalPanHandlers?: GestureResponderHandlers;
  onControlUse: (control: TerminalControlId) => void;
  onHistoryEntry: (entry: string) => void;
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
  swipe,
  terminalPanHandlers,
  onControlUse,
  onHistoryEntry,
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
  const composeAttachmentsRef = useRef<ComposeAttachment[]>([]);
  const composeInputRef = useRef<TextInputHandle | null>(null);
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [keyboardEnabled, setKeyboardEnabled] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const { inset: keyboardInset } = useKeyboardInset(controlsRef, {
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
  activeTargetRef.current = activeTarget;

  useEffect(() => {
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
    for (const attachment of composeAttachmentsRef.current) attachment.dispose();
    composeAttachmentsRef.current = [];
    setComposeAttachments([]);
  }, [activeTarget?.key, setAlt, setCtrl, setShift]);

  useEffect(() => {
    setScrollPosition(activeTarget?.scroll);
  }, [activeTarget?.key, activeTarget?.scroll]);

  const writeInput = async (
    data: string,
    target: TerminalRenderTarget | null = activeTargetRef.current,
    refocusTerminal = true,
  ): Promise<boolean> => {
    if (!target) return false;
    onInteraction?.(target);
    setScrollPosition(current => current ? { ...current, offset_from_bottom: 0 } : current);
    try {
      await target.client.writeToTerminal(target.session.terminalId, data);
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
    if (!ready) return;
    renderer.current?.setKeyboardEnabled(keyboardEnabled);
    if (!keyboardEnabled) {
      Keyboard.dismiss();
    }
  }, [activeTarget?.key, composeExpanded, composeOpen, keyboardEnabled, ready]);

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
    if (composeOpen && pasteRequest.previewUri) {
      const attachment = {
        id: pasteRequest.id,
        remotePath: pasteRequest.text,
        previewUri: pasteRequest.previewUri,
        dispose: pasteRequest.dispose || (() => {}),
      };
      composeAttachmentsRef.current = [...composeAttachmentsRef.current, attachment];
      setComposeAttachments(composeAttachmentsRef.current);
      return;
    }
    if (composeOpen) {
      setComposeText(current => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${pasteRequest.text}`);
      pasteRequest.dispose?.();
      return;
    }
    renderer.current?.paste(pasteRequest.text);
    onHistoryEntry(pasteRequest.text);
    pasteRequest.dispose?.();
  }, [composeOpen, onHistoryEntry, pasteRequest, ready, visible]);

  useEffect(() => () => {
    for (const attachment of composeAttachmentsRef.current) attachment.dispose();
    composeAttachmentsRef.current = [];
  }, []);

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
    setKeyboardEnabled(true);
    setTerminalComposerOverlay(terminalId, true).catch(reason => setError(String(reason))).finally(() => {
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
    if (activeTargetRef.current) onInteraction?.(activeTargetRef.current);
    const attachmentPaths = composeAttachmentsRef.current.map(attachment => attachment.remotePath);
    const submitted = [composeText.trimEnd(), ...attachmentPaths].filter(Boolean).join(' ');
    if (!submitted) {
      sendInput(ENTER_INPUT);
      return;
    }
    renderer.current?.submit(submitted);
    onHistoryEntry(submitted);
    setComposeText('');
    for (const attachment of composeAttachmentsRef.current) attachment.dispose();
    composeAttachmentsRef.current = [];
    setComposeAttachments([]);
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
    setComposeAttachments(composeAttachmentsRef.current);
  };

  const updateComposeText = (value: string) => {
    if (activeTargetRef.current) onInteraction?.(activeTargetRef.current);
    setComposeText(value);
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
          accessibilityLabel={keyboardEnabled ? t('terminal.disableKeyboard') : t('terminal.enableKeyboard')}
          accessibilityState={{ selected: keyboardEnabled }}
          className={cn(TERMINAL_ICON_CONTROL_CLASS, keyboardEnabled && 'border-primary bg-primary/15')}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            const enabled = !keyboardEnabled;
            if (enabled) renderer.current?.setKeyboardEnabled(true);
            setKeyboardEnabled(enabled);
            if (enabled) {
              setTimeout(() => {
                if (composeOpen) {
                  composeInputRef.current?.focus();
                } else {
                  renderer.current?.focus();
                }
              }, 40);
            } else {
              Keyboard.dismiss();
              renderer.current?.blur();
            }
          }}>
          <View className={TERMINAL_ICON_BOX_CLASS}>
            <KeyboardIcon size={TERMINAL_ICON_SIZE} color={keyboardEnabled ? appColors.primary : appColors.text} />
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
      className={cn('flex-1 bg-transparent', (!visible || !session) && 'absolute inset-0 opacity-0')}>
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
      {compact && error && <Text className="bg-terminal-error/15 px-2 py-1 text-[8px] text-terminal-error">{t('terminal.attachFailed')} · {String(error)}</Text>}
      {searchOpen && (
        <View className="min-h-12 flex-row items-center gap-1 border-b border-terminal-divider bg-terminal-surface px-[7px]">
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
          onStatus={onStatus}
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
        <View className="absolute inset-0 z-20 items-center justify-center bg-terminal-canvas/95 p-[30px]">
          <View className={cn('size-2 rounded-full bg-terminal-success', status === 'error' && 'bg-terminal-error')} />
          <Text className="mt-[15px] text-center text-[17px] font-semibold leading-[22px] text-terminal-text">
            {status === 'connecting' ? t('terminal.connecting') : status === 'disconnected' ? t('terminal.reconnecting') : t('terminal.failed')}
          </Text>
          <Text numberOfLines={3} className="mt-2 max-w-80 text-center text-[11px] leading-[17px] text-terminal-muted">
            {session.error || error || t('terminal.opening', { title })}
          </Text>
          {status === 'disconnected' && session.reconnectAttempt > 0 && (
            <Text className="mt-2.5 text-[11px] text-terminal-muted">{t('terminal.attempt', { attempt: session.reconnectAttempt, total: MAX_RECONNECT_ATTEMPTS })}</Text>
          )}
          <View className="mt-5 flex-row gap-2">
            {status !== 'connecting' && (
              <Button className="min-h-[42px] rounded-full bg-terminal-accent px-4" onPress={retryNow}><Text className="text-[13px] font-semibold text-terminal-ink">{t('terminal.retry')}</Text></Button>
            )}
            <Button className="min-h-[42px] rounded-full bg-terminal-surface px-4" variant="secondary" onPress={onClose}><Text className="text-[13px] font-semibold text-terminal-text">{t('terminal.closeSession')}</Text></Button>
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
                  <ComposeAttachmentsStrip
                    attachments={composeAttachments}
                    removeLabel={t('terminal.removeAttachment')}
                    onRemove={removeComposeAttachment}
                  />
                  <Input
                    ref={composeInputRef}
                    autoFocus={keyboardEnabled}
                    showSoftInputOnFocus={keyboardEnabled}
                    multiline
                    numberOfLines={3}
                    textAlignVertical="top"
                    value={composeText}
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
            <ComposeAttachmentsStrip
              attachments={composeAttachments}
              removeLabel={t('terminal.removeAttachment')}
              onRemove={removeComposeAttachment}
              expanded
            />
            <Input
              ref={composeInputRef}
              autoFocus={keyboardEnabled}
              showSoftInputOnFocus={keyboardEnabled}
              multiline
              textAlignVertical="top"
              value={composeText}
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

interface ComposeAttachment {
  id: number;
  remotePath: string;
  previewUri: string;
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
          <Image className="size-full" resizeMode="cover" source={{ uri: attachment.previewUri }} />
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
