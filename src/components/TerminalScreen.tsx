import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, FolderOpen, ImagePlus, MessageCircle, Paperclip, Send, X } from 'lucide-react-native';
import { AppState, Clipboard, Image, Keyboard, ScrollView, StyleSheet, View, type GestureResponderHandlers } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import WebView from 'react-native-webview/lib/WebView.android';
import type { WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';

import { cn } from '@/src/lib/utils';
import {
  orderTerminalControls,
  type TerminalControlId,
  type TerminalControlUsage,
} from '../lib/terminalControls';
import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalPreferences } from '../services/devicePreferences';
import type { TerminalFrame } from '../lib/terminalBridge';
import { applyTerminalModifiers, type TerminalModifierState } from '../lib/terminalInput';
import { moveTerminalScroll, terminalScrollThumb } from '../lib/terminalScroll';
import type { TerminalSession, TerminalSessionStatus } from '../terminalSessions';
import type { PaneScrollInfo } from '../types';
import { colors, useTheme } from '../theme';
import { terminalHtml } from '../generated/terminalHtml';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  client: HerdrClient;
  visible: boolean;
  session: TerminalSession | null;
  scroll?: PaneScrollInfo;
  preferences: TerminalPreferences;
  controlUsage: TerminalControlUsage;
  compact?: boolean;
  preview?: boolean;
  terminalPanHandlers?: GestureResponderHandlers;
  onFontSizeChange: (fontSize: number) => void;
  onControlUse: (control: TerminalControlId) => void;
  linkScanRequest?: number;
  pasteRequest?: {
    id: number;
    text: string;
    previewUri?: string | null;
    dispose?: () => void;
  };
  onRequestAttachment?: () => void;
  onRequestFiles?: () => void;
  onLinksScanned?: (links: string[]) => void;
  onClose: () => void;
  onStatus: (status: TerminalSessionStatus, error?: string, reconnectAttempt?: number) => void;
}

interface WebViewHandle {
  injectJavaScript: (script: string) => void;
}

const TERMINAL_KEYS: Partial<Record<TerminalControlId, readonly [string, string]>> = {
  esc: ['ESC', '\u001b'],
  tab: ['TAB', '\t'],
  up: ['↑', '\u001b[A'],
  left: ['←', '\u001b[D'],
  right: ['→', '\u001b[C'],
  down: ['↓', '\u001b[B'],
  enter: ['ENTER', '\r'],
  slash: ['/', '/'],
  hyphen: ['-', '-'],
  pipe: ['|', '|'],
  tilde: ['~', '~'],
  end: ['END', '\u001b[F'],
  'page-up': ['PG↑', '\u001b[5~'],
  'page-down': ['PG↓', '\u001b[6~'],
  'shift-tab': ['⇧TAB', '\u001b[Z'],
  home: ['HOME', '\u001b[H'],
};

const MAX_RECONNECT_ATTEMPTS = 5;
const FRAME_CHUNK_SIZE = 16_384;
const WEBVIEW_STYLE = { flex: 1, backgroundColor: 'transparent' } as const;
const WEBVIEW_CONTAINER_STYLE = { backgroundColor: 'transparent' } as const;
const BACKGROUND_SCREEN_STYLE = { mixBlendMode: 'screen' } as const;
const TERMINAL_CONTROL_CLASS = 'min-h-[34px] min-w-12 rounded-sm border border-border bg-card/70 px-2.5 active:bg-card/80';

export function TerminalScreen({ client, visible, session, scroll, preferences, controlUsage, compact = false, preview = false, terminalPanHandlers, onFontSizeChange, onControlUse, linkScanRequest = 0, pasteRequest, onRequestAttachment, onRequestFiles, onLinksScanned, onClose, onStatus }: Props) {
  const { colors: appColors } = useTheme();
  const { t } = useTranslation();
  const { bottom: bottomSafeAreaInset } = useSafeAreaInsets();
  const terminalId = session?.terminalId || '';
  const title = session?.title || '';
  const status = session?.status || 'connecting';
  const webView = useRef<WebViewHandle | null>(null);
  const controlsRef = useRef<View | null>(null);
  const readyRef = useRef(false);
  const resetOnNextFrame = useRef(true);
  const pendingFrames = useRef<TerminalFrame[]>([]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempt = useRef(session?.reconnectAttempt || 0);
  const handledPasteRequest = useRef(0);
  const composeAttachmentsRef = useRef<ComposeAttachment[]>([]);
  const wasVisible = useRef(visible);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctrl, setCtrl] = useState<TerminalModifierState>('off');
  const [shift, setShift] = useState<TerminalModifierState>('off');
  const [alt, setAlt] = useState<TerminalModifierState>('off');
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResult, setSearchResult] = useState({ count: 0, index: -1, invalid: false });
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([]);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [scrollPosition, setScrollPosition] = useState(scroll);
  const [controlOrder] = useState(() => orderTerminalControls(controlUsage));
  const scrollThumb = terminalScrollThumb(scrollPosition);
  const presented = visible || preview;

  useEffect(() => {
    setScrollPosition(scroll);
  }, [scroll, terminalId]);

  const reportStatus = useEffectEvent(onStatus);

  const injectFrame = (frame: TerminalFrame) => {
    const reset = resetOnNextFrame.current;
    if (reset) resetOnNextFrame.current = false;
    const resetScript = reset ? 'window.herdrReset(); ' : '';
    if (typeof frame.final === 'boolean') {
      webView.current?.injectJavaScript(
        `${resetScript}window.herdrWriteBase64Chunk(${frame.seq}, ${JSON.stringify(frame.bytes)}, ${frame.final}); true;`,
      );
      return;
    }
    for (let offset = 0; offset < frame.bytes.length; offset += FRAME_CHUNK_SIZE) {
      const chunk = frame.bytes.slice(offset, offset + FRAME_CHUNK_SIZE);
      const final = offset + FRAME_CHUNK_SIZE >= frame.bytes.length;
      webView.current?.injectJavaScript(
        `${offset === 0 ? resetScript : ''}window.herdrWriteBase64Chunk(${frame.seq}, ${JSON.stringify(chunk)}, ${final}); true;`,
      );
    }
  };

  const writeFrame = useEffectEvent((frame: TerminalFrame) => {
    if (!readyRef.current) {
      pendingFrames.current.push(frame);
      return;
    }
    injectFrame(frame);
  });

  const writeInput = async (data: string, refocusTerminal = true): Promise<boolean> => {
    setScrollPosition(current => current ? { ...current, offset_from_bottom: 0 } : current);
    try {
      await client.writeToTerminal(terminalId, data);
      if (refocusTerminal && keyboardVisible) webView.current?.injectJavaScript('window.herdrFocus(); true;');
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    }
  };

  const sendInput = async (data: string) => {
    const value = applyTerminalModifiers(data, ctrl, alt, shift);
    if (ctrl === 'armed') setCtrl('off');
    if (shift === 'armed') setShift('off');
    if (alt === 'armed') setAlt('off');
    return writeInput(value);
  };

  useEffect(() => {
    // Visibility activates and touches the terminal's per-host LRU entry. The
    // bridge stays attached when navigating elsewhere in the app, while the
    // client evicts older hidden terminals before reaching SSH MaxSessions.
    if (!terminalId || !visible) return;
    if (AppState.currentState !== 'active') return;
    let active = true;
    const retained = client.isTerminalBridgeRetained(terminalId);
    if (!retained) {
      resetOnNextFrame.current = true;
      pendingFrames.current = [];
    }
    setError(null);
    if (!retained) reportStatus('connecting', undefined, reconnectAttempt.current);
    const scheduleReconnect = (reason: string) => {
      if (!active || AppState.currentState !== 'active') return;
      const nextAttempt = reconnectAttempt.current + 1;
      if (nextAttempt > MAX_RECONNECT_ATTEMPTS) {
        reportStatus('error', reason, reconnectAttempt.current);
        return;
      }
      reconnectAttempt.current = nextAttempt;
      reportStatus('disconnected', reason, nextAttempt);
      reconnectTimer.current = setTimeout(
        () => active && setConnectionGeneration(value => value + 1),
        Math.min(8000, 750 * (2 ** (nextAttempt - 1))),
      );
    };
    client.openTerminal(
      terminalId,
      writeFrame,
      reason => scheduleReconnect(reason || t('terminal.remoteClosed')),
    ).then(() => {
      if (active) {
        reconnectAttempt.current = 0;
        reportStatus('connected', undefined, 0);
      }
    }).catch(reason => {
      const message = String(reason);
      if (active) {
        setError(message);
        scheduleReconnect(message);
      }
    });
    return () => {
      active = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [client, connectionGeneration, t, terminalId, visible]);

  useEffect(() => {
    if (!terminalId) return;
    return () => {
      client.releaseTerminal(terminalId).catch(() => client.closeTerminal(terminalId));
    };
  }, [client, terminalId]);

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const wasActive = previous === 'active';
      previous = state;
      if (
        state === 'active'
        && !wasActive
        && terminalId
        && !client.isTerminalBridgeRetained(terminalId)
      ) {
        reconnectAttempt.current = 0;
        setConnectionGeneration(value => value + 1);
      }
    });
    return () => subscription.remove();
  }, [client, terminalId]);

  useEffect(() => {
    reconnectAttempt.current = session?.reconnectAttempt || 0;
  }, [session?.reconnectAttempt]);

  useEffect(() => {
    if (!ready) {
      wasVisible.current = visible;
      return;
    }
    if (!visible) {
      if (wasVisible.current) webView.current?.injectJavaScript('window.herdrBlur(); true;');
      wasVisible.current = false;
      return;
    }
    wasVisible.current = true;
    const timer = setTimeout(() => {
      webView.current?.injectJavaScript(
        `window.herdrFit(); ${keyboardVisible ? 'window.herdrFocus();' : ''} true;`,
      );
    }, 40);
    return () => clearTimeout(timer);
  }, [keyboardVisible, ready, visible]);

  useEffect(() => {
    if (!ready) return;
    webView.current?.injectJavaScript(`window.herdrConfigure(${JSON.stringify({ ...preferences, backgroundImageUri: null })}); true;`);
  }, [preferences, ready]);

  useEffect(() => {
    if (!linkScanRequest || !ready || !visible) return;
    webView.current?.injectJavaScript('window.herdrScanLinks(); true;');
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
    const value = JSON.stringify(pasteRequest.text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    webView.current?.injectJavaScript(`window.herdrPaste(${value}); true;`);
    pasteRequest.dispose?.();
  }, [composeOpen, pasteRequest, ready, visible]);

  useEffect(() => () => {
    for (const attachment of composeAttachmentsRef.current) attachment.dispose();
    composeAttachmentsRef.current = [];
  }, []);

  useEffect(() => {
    let insetTimer: ReturnType<typeof setTimeout> | null = null;
    const show = Keyboard.addListener('keyboardDidShow', event => {
      if (insetTimer) clearTimeout(insetTimer);
      setKeyboardVisible(true);
      setKeyboardInset(0);
      insetTimer = setTimeout(() => {
        const keyboardTop = event.endCoordinates.screenY;
        controlsRef.current?.measureInWindow((_x, y, _width, height) => {
          setKeyboardInset(Math.max(0, Math.ceil(y + height - keyboardTop)));
        });
      }, 50);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      if (insetTimer) clearTimeout(insetTimer);
      insetTimer = null;
      setKeyboardVisible(false);
      setKeyboardInset(0);
    });
    return () => {
      if (insetTimer) clearTimeout(insetTimer);
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!searchOpen) {
      webView.current?.injectJavaScript('window.herdrClearSearch(); true;');
      return;
    }
    const query = JSON.stringify(searchQuery).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    webView.current?.injectJavaScript(`window.herdrSearch(${query}, ${searchCase}, ${searchRegex}, 0); true;`);
  }, [ready, searchCase, searchOpen, searchQuery, searchRegex]);

  const pasteClipboard = async () => {
    const value = await Clipboard.getString();
    if (!value) return;
    const encoded = JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    webView.current?.injectJavaScript(`window.herdrPaste(${encoded}); true;`);
  };

  const moveSearch = (direction: -1 | 1) => {
    const query = JSON.stringify(searchQuery).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    webView.current?.injectJavaScript(`window.herdrSearch(${query}, ${searchCase}, ${searchRegex}, ${direction}); true;`);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setTimeout(() => webView.current?.injectJavaScript('window.herdrFocus(); true;'), 40);
  };

  const handleMessage = async (event: WebViewMessageEvent) => {
    const message = JSON.parse(event.nativeEvent.data);
    if (message.type === 'ready') {
      readyRef.current = true;
      setReady(true);
      const frames = pendingFrames.current;
      pendingFrames.current = [];
      for (const frame of frames) injectFrame(frame);
      return;
    }
    if (message.type === 'input') {
      await sendInput(message.data);
    } else if (message.type === 'buffered-submit') {
      await writeInput(message.data, false);
    } else if (message.type === 'resize') {
      if (!terminalId) return;
      client.resizeTerminal(
        terminalId,
        message.cols,
        message.rows,
        message.cellWidthPx,
        message.cellHeightPx,
      );
    } else if (message.type === 'scroll') {
      setScrollPosition(current => moveTerminalScroll(current, message.direction, message.lines));
      try {
        await client.scrollTerminal(terminalId, message.direction, message.lines);
      } catch (reason) {
        setError(String(reason));
      }
    } else if (message.type === 'font-size-change') {
      const fontSize = Number(message.fontSize);
      if (Number.isFinite(fontSize)) {
        onFontSizeChange(Math.max(8, Math.min(24, Math.round(fontSize))));
      }
    } else if (message.type === 'clipboard-write') {
      Clipboard.setString(message.text || '');
    } else if (message.type === 'clipboard-read') {
      await pasteClipboard();
    } else if (message.type === 'search-result') {
      setSearchResult({ count: message.count, index: message.index, invalid: Boolean(message.invalid) });
    } else if (message.type === 'link-scan-result') {
      onLinksScanned?.(Array.isArray(message.links) ? message.links.filter((link: unknown) => typeof link === 'string') : []);
    }
  };

  const retryNow = () => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    client.closeTerminal(terminalId);
    reconnectAttempt.current = 0;
    onStatus('connecting', undefined, 0);
    setConnectionGeneration(value => value + 1);
  };

  const closeCompose = () => {
    setComposeOpen(false);
    setTimeout(() => webView.current?.injectJavaScript('window.herdrFocus(); true;'), 40);
  };

  const submitCompose = () => {
    const attachmentPaths = composeAttachmentsRef.current.map(attachment => attachment.remotePath);
    const submitted = [composeText.trimEnd(), ...attachmentPaths].filter(Boolean).join(' ');
    if (!submitted) return;
    const value = JSON.stringify(submitted).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    webView.current?.injectJavaScript(`window.herdrSubmit(${value}); true;`);
    setComposeText('');
    for (const attachment of composeAttachmentsRef.current) attachment.dispose();
    composeAttachmentsRef.current = [];
    setComposeAttachments([]);
  };

  const removeComposeAttachment = (id: number) => {
    const attachment = composeAttachmentsRef.current.find(item => item.id === id);
    attachment?.dispose();
    composeAttachmentsRef.current = composeAttachmentsRef.current.filter(item => item.id !== id);
    setComposeAttachments(composeAttachmentsRef.current);
  };

  const renderTerminalControl = (control: TerminalControlId) => {
    const key = TERMINAL_KEYS[control];
    if (key) {
      return (
        <TerminalKey
          key={control}
          label={key[0]}
          onPress={() => {
            onControlUse(control);
            sendInput(key[1]);
          }}
        />
      );
    }
    if (control === 'paste') {
      return (
        <TerminalKey
          key={control}
          label={t('terminal.paste')}
          onPress={() => {
            onControlUse(control);
            pasteClipboard().catch(reason => setError(String(reason)));
          }}
        />
      );
    }
    if (control === 'compose') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.compose')}
          accessibilityState={{ selected: composeOpen }}
          className={cn(TERMINAL_CONTROL_CLASS, composeOpen && 'border-primary')}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            if (composeOpen) closeCompose();
            else {
              setSearchOpen(false);
              setComposeOpen(true);
            }
          }}>
          <MessageCircle size={16} color={appColors.text} />
        </Button>
      );
    }
    if (control === 'attach') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.attach')}
          className={TERMINAL_CONTROL_CLASS}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            onRequestAttachment?.();
          }}>
          <Paperclip size={16} color={appColors.text} />
        </Button>
      );
    }
    if (control === 'files') {
      return (
        <Button
          key={control}
          accessibilityLabel={t('terminal.openFiles')}
          className={TERMINAL_CONTROL_CLASS}
          variant="secondary"
          onPress={() => {
            onControlUse(control);
            onRequestFiles?.();
          }}>
          <FolderOpen size={16} color={appColors.text} />
        </Button>
      );
    }
    if (control === 'find') {
      return (
        <TerminalKey
          key={control}
          label={t('terminal.find')}
          armed={searchOpen}
          onPress={() => {
            onControlUse(control);
            setComposeOpen(false);
            setSearchOpen(value => !value);
          }}
        />
      );
    }
    if (control === 'ctrl') {
      return (
        <Button
          key={control}
          accessibilityState={{ selected: ctrl !== 'off' }}
          onPress={() => {
            onControlUse(control);
            setCtrl(value => value === 'off' ? 'armed' : 'off');
          }}
          onLongPress={() => setCtrl('locked')}
          delayLongPress={450}
          className={cn(TERMINAL_CONTROL_CLASS, ctrl === 'armed' && 'border-primary', ctrl === 'locked' && 'border-primary bg-primary/70 active:bg-primary/80')}
          variant="secondary">
          <Text className={cn('font-mono text-[9px] font-bold text-foreground', ctrl === 'armed' && 'text-primary', ctrl === 'locked' && 'text-primary-foreground')}>CTRL</Text>
        </Button>
      );
    }
    if (control === 'shift') {
      return (
        <Button
          key={control}
          accessibilityState={{ selected: shift !== 'off' }}
          onPress={() => {
            onControlUse(control);
            setShift(value => value === 'off' ? 'armed' : 'off');
          }}
          onLongPress={() => setShift('locked')}
          delayLongPress={450}
          className={cn(TERMINAL_CONTROL_CLASS, shift === 'armed' && 'border-primary', shift === 'locked' && 'border-primary bg-primary/70 active:bg-primary/80')}
          variant="secondary">
          <Text className={cn('font-mono text-[9px] font-bold text-foreground', shift === 'armed' && 'text-primary', shift === 'locked' && 'text-primary-foreground')}>SHIFT</Text>
        </Button>
      );
    }
    if (control !== 'alt') return null;
    return (
      <Button
        key={control}
        accessibilityState={{ selected: alt !== 'off' }}
        onPress={() => {
          onControlUse(control);
          setAlt(value => value === 'off' ? 'armed' : 'off');
        }}
        onLongPress={() => setAlt('locked')}
        delayLongPress={450}
        className={cn(TERMINAL_CONTROL_CLASS, alt === 'armed' && 'border-primary', alt === 'locked' && 'border-primary bg-primary/70 active:bg-primary/80')}
        variant="secondary">
        <Text className={cn('font-mono text-[9px] font-bold text-foreground', alt === 'armed' && 'text-primary', alt === 'locked' && 'text-primary-foreground')}>ALT</Text>
      </Button>
    );
  };

  return (
    <View
      accessibilityElementsHidden={!visible || !session}
      importantForAccessibility={visible && session ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible && session ? 'auto' : 'none'}
      className={cn('flex-1 bg-transparent', (!presented || !session) && 'absolute inset-0 opacity-0')}>
      {preferences.backgroundImageUri && (
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
      )}
      {!compact && (
        <View className="h-[30px] flex-row items-center gap-2 border-b border-terminal-divider bg-terminal-panel px-3">
          <View className="size-1.5 rounded-full bg-white" />
          <Text numberOfLines={1} className="flex-1 font-mono text-[9px] tracking-[1px] text-terminal-muted">
            {t('terminal.agentTitle', { title, terminalId })}
          </Text>
          {error && <Text className="font-mono text-[8px] text-terminal-error">{t('terminal.attachFailed')}</Text>}
        </View>
      )}
      {compact && error && <Text className="bg-terminal-error/15 px-2 py-1 font-mono text-[8px] text-terminal-error">{t('terminal.attachFailed')} · {String(error)}</Text>}
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
      <View className="relative flex-1" {...terminalPanHandlers}>
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
          style={WEBVIEW_STYLE}
          containerStyle={WEBVIEW_CONTAINER_STYLE}
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
      <View
        ref={controlsRef}
        collapsable={false}
        style={keyboardInset > 0 ? { marginBottom: keyboardInset } : undefined}>
        {composeOpen && (
          <View className="border-t border-terminal-divider bg-terminal-panel p-2">
            <View className="flex-row items-end gap-2">
              <Button
                accessibilityLabel={t('terminal.attach')}
                className="size-10 rounded-full bg-terminal-surface px-0"
                variant="secondary"
                onPress={onRequestAttachment}>
                <ImagePlus size={18} color={colors.text} />
              </Button>
              <View className="min-w-0 flex-1 overflow-hidden rounded-lg border border-terminal-divider bg-terminal-canvas">
                {composeAttachments.length > 0 && (
                  <ScrollView
                    horizontal
                    keyboardShouldPersistTaps="always"
                    showsHorizontalScrollIndicator={false}
                    className="mx-2 mt-2 flex-grow-0"
                    contentContainerClassName="gap-2">
                    {composeAttachments.map(attachment => (
                      <View key={attachment.id} className="relative size-16 overflow-hidden rounded-lg border border-terminal-divider bg-terminal-surface">
                        <Image className="size-full" resizeMode="cover" source={{ uri: attachment.previewUri }} />
                        <Button
                          accessibilityLabel={t('terminal.removeAttachment')}
                          className="absolute right-0.5 top-0.5 size-6 rounded-full bg-black/75 px-0"
                          onPress={() => removeComposeAttachment(attachment.id)}>
                          <X size={13} color="#fff" />
                        </Button>
                      </View>
                    ))}
                  </ScrollView>
                )}
                <Input
                  autoFocus
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  value={composeText}
                  onChangeText={setComposeText}
                  placeholder={t('terminal.composePlaceholder')}
                  placeholderTextColor={colors.muted}
                  className="h-[76px] rounded-none border-0 bg-transparent px-3 py-2 font-mono text-[12px] leading-[17px] text-terminal-text"
                />
              </View>
              <View className="gap-1.5">
                <Button
                  accessibilityLabel={t('terminal.sendBufferedInput')}
                  disabled={!composeText.trim() && composeAttachments.length === 0}
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
        )}
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          className="flex-grow-0"
          contentContainerClassName="items-center gap-[5px] px-1.5 pt-[7px]"
          contentContainerStyle={{ paddingBottom: 7 + (keyboardVisible ? 0 : bottomSafeAreaInset) }}>
          {controlOrder.map(renderTerminalControl)}
        </ScrollView>
      </View>
    </View>
  );
}

interface ComposeAttachment {
  id: number;
  remotePath: string;
  previewUri: string;
  dispose: () => void;
}

function TerminalKey({ label, onPress, armed = false }: { label: string; onPress: () => void; armed?: boolean }) {
  return <Button className={cn(TERMINAL_CONTROL_CLASS, armed && 'border-primary')} variant="secondary" onPress={onPress}><Text className={cn('font-mono text-[9px] font-bold text-foreground', armed && 'text-primary')}>{label}</Text></Button>;
}
