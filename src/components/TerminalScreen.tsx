import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Clipboard, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import WebView from 'react-native-webview/lib/WebView.android';
import type { WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';

import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalPreferences } from '../services/devicePreferences';
import type { TerminalFrame } from '../lib/terminalBridge';
import type { TerminalSession, TerminalSessionStatus } from '../terminalSessions';
import { colors } from '../theme';
import { terminalHtml } from '../generated/terminalHtml';

interface Props {
  client: HerdrClient;
  visible: boolean;
  session: TerminalSession;
  preferences: TerminalPreferences;
  compact?: boolean;
  onClose: () => void;
  onStatus: (status: TerminalSessionStatus, error?: string, reconnectAttempt?: number) => void;
}

interface WebViewHandle {
  injectJavaScript: (script: string) => void;
}

type ModifierState = 'off' | 'armed' | 'locked';

const KEYS = [
  ['ESC', '\u001b'],
  ['CTRL+C', '\u0003'],
  ['TAB', '\t'],
  ['⇧TAB', '\u001b[Z'],
  ['↑', '\u001b[A'],
  ['↓', '\u001b[B'],
  ['←', '\u001b[D'],
  ['→', '\u001b[C'],
  ['HOME', '\u001b[H'],
  ['END', '\u001b[F'],
  ['PG↑', '\u001b[5~'],
  ['PG↓', '\u001b[6~'],
  ['-', '-'],
  ['/', '/'],
  ['|', '|'],
  ['~', '~'],
  ['ENTER', '\r'],
] as const;

const MAX_RECONNECT_ATTEMPTS = 5;

export function TerminalScreen({ client, visible, session, preferences, compact = false, onClose, onStatus }: Props) {
  const { terminalId, title, status } = session;
  const webView = useRef<WebViewHandle | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempt = useRef(session.reconnectAttempt);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctrl, setCtrl] = useState<ModifierState>('off');
  const [alt, setAlt] = useState<ModifierState>('off');
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResult, setSearchResult] = useState({ count: 0, index: -1, invalid: false });
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const reportStatus = useEffectEvent(onStatus);

  const writeFrame = useEffectEvent((frame: TerminalFrame) => {
    const encoded = JSON.stringify(frame.bytes);
    webView.current?.injectJavaScript(`window.herdrWriteBase64(${encoded}); true;`);
  });

  const sendInput = async (data: string) => {
    let value = data;
    if (ctrl !== 'off' && value.length === 1) value = String.fromCharCode(value.toUpperCase().charCodeAt(0) % 32);
    if (alt !== 'off') value = `\u001b${value}`;
    if (ctrl === 'armed') setCtrl('off');
    if (alt === 'armed') setAlt('off');
    try {
      await client.writeToTerminal(terminalId, value);
      if (keyboardVisible) webView.current?.injectJavaScript('window.herdrFocus(); true;');
    } catch (reason) {
      setError(String(reason));
    }
  };

  useEffect(() => {
    if (!ready || !terminalId) {
      return;
    }
    let active = true;
    setError(null);
    reportStatus('connecting', undefined, reconnectAttempt.current);
    webView.current?.injectJavaScript('window.herdrReset(); true;');
    const scheduleReconnect = (reason: string) => {
      if (!active) return;
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
      reason => scheduleReconnect(reason || 'The remote terminal closed.'),
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
      client.closeTerminal(terminalId);
    };
  }, [client, connectionGeneration, ready, terminalId]);

  useEffect(() => {
    reconnectAttempt.current = session.reconnectAttempt;
  }, [session.reconnectAttempt]);

  useEffect(() => {
    if (visible && ready) {
      webView.current?.injectJavaScript('setTimeout(() => window.herdrFit(), 32); true;');
    }
  }, [ready, visible]);

  useEffect(() => {
    if (!ready) return;
    webView.current?.injectJavaScript(`window.herdrConfigure(${JSON.stringify(preferences)}); true;`);
  }, [preferences, ready]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
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
      setReady(true);
      return;
    }
    if (message.type === 'input') {
      await sendInput(message.data);
    } else if (message.type === 'resize') {
      client.resizeTerminal(
        terminalId,
        message.cols,
        message.rows,
        message.cellWidthPx,
        message.cellHeightPx,
      );
    } else if (message.type === 'scroll') {
      try {
        await client.scrollTerminal(terminalId, message.direction, message.lines);
      } catch (reason) {
        setError(String(reason));
      }
    } else if (message.type === 'clipboard-write') {
      Clipboard.setString(message.text || '');
    } else if (message.type === 'clipboard-read') {
      await pasteClipboard();
    } else if (message.type === 'search-result') {
      setSearchResult({ count: message.count, index: message.index, invalid: Boolean(message.invalid) });
    }
  };

  const retryNow = () => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    client.closeTerminal(terminalId);
    reconnectAttempt.current = 0;
    onStatus('connecting', undefined, 0);
    setConnectionGeneration(value => value + 1);
  };

  return (
    <View style={[styles.page, !visible && styles.hidden]}>
      {!compact && (
        <View style={styles.statusBar}>
          <View style={styles.liveDot} />
          <Text numberOfLines={1} style={[styles.statusText, styles.statusGrow]}>
            AGENT TERMINAL · {title} · {terminalId}
          </Text>
          {error && <Text style={styles.error}>ATTACH FAILED</Text>}
        </View>
      )}
      {compact && error && <Text style={styles.compactError}>ATTACH FAILED · {String(error)}</Text>}
      {searchOpen && (
        <View style={styles.searchBar}>
          <TextInput
            autoFocus
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={() => moveSearch(1)}
            placeholder="Find in terminal"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
          <Pressable onPress={() => setSearchCase(value => !value)} style={[styles.searchToggle, searchCase && styles.searchToggleActive]}>
            <Text style={[styles.searchToggleText, searchCase && styles.searchToggleTextActive]}>Aa</Text>
          </Pressable>
          <Pressable onPress={() => setSearchRegex(value => !value)} style={[styles.searchToggle, searchRegex && styles.searchToggleActive]}>
            <Text style={[styles.searchToggleText, searchRegex && styles.searchToggleTextActive]}>.*</Text>
          </Pressable>
          <Text style={[styles.searchCount, (searchResult.invalid || (searchQuery && searchResult.count === 0)) && styles.searchCountError]}>
            {searchResult.invalid ? 'ERR' : searchQuery ? `${Math.max(0, searchResult.index + 1)}/${searchResult.count}` : ''}
          </Text>
          <Pressable disabled={!searchResult.count} onPress={() => moveSearch(-1)} style={styles.searchAction}><Text style={styles.searchActionText}>↑</Text></Pressable>
          <Pressable disabled={!searchResult.count} onPress={() => moveSearch(1)} style={styles.searchAction}><Text style={styles.searchActionText}>↓</Text></Pressable>
          <Pressable onPress={closeSearch} style={styles.searchAction}><Text style={styles.searchActionText}>×</Text></Pressable>
        </View>
      )}
      <WebView
        ref={value => {
          webView.current = value as WebViewHandle | null;
        }}
        source={{ html: terminalHtml, baseUrl: 'file:///android_asset/' }}
        originWhitelist={['file://*', 'about:blank']}
        allowFileAccess
        javaScriptEnabled
        onMessage={handleMessage}
        style={styles.webview}
      />
      {status !== 'connected' && (
        <View style={styles.connectionOverlay}>
          <View style={[styles.connectionMark, status === 'error' && styles.connectionMarkError]} />
          <Text style={styles.connectionTitle}>
            {status === 'connecting' ? 'CONNECTING TERMINAL' : status === 'disconnected' ? 'RECONNECTING TERMINAL' : 'TERMINAL CONNECTION FAILED'}
          </Text>
          <Text numberOfLines={3} style={styles.connectionCopy}>
            {session.error || error || `Opening ${title}`}
          </Text>
          {status === 'disconnected' && session.reconnectAttempt > 0 && (
            <Text style={styles.connectionAttempt}>ATTEMPT {session.reconnectAttempt} / {MAX_RECONNECT_ATTEMPTS}</Text>
          )}
          <View style={styles.connectionActions}>
            {status !== 'connecting' && (
              <Pressable onPress={retryNow} style={styles.retryButton}><Text style={styles.retryText}>RETRY NOW</Text></Pressable>
            )}
            <Pressable onPress={onClose} style={styles.dismissButton}><Text style={styles.dismissText}>CLOSE SESSION</Text></Pressable>
          </View>
        </View>
      )}
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        style={styles.keyRail}
        contentContainerStyle={styles.keyRailContent}>
        <Pressable onPress={() => setSearchOpen(value => !value)} style={[styles.key, searchOpen && styles.keyArmed]}>
          <Text style={[styles.keyText, searchOpen && styles.keyTextArmed]}>FIND</Text>
        </Pressable>
        <Pressable onPress={() => { pasteClipboard().catch(reason => setError(String(reason))); }} style={styles.key}>
          <Text style={styles.keyText}>PASTE</Text>
        </Pressable>
        <Pressable
          accessibilityState={{ selected: ctrl !== 'off' }}
          onPress={() => setCtrl(value => value === 'off' ? 'armed' : 'off')}
          onLongPress={() => setCtrl('locked')}
          delayLongPress={450}
          style={[styles.key, ctrl === 'armed' && styles.keyArmed, ctrl === 'locked' && styles.keyActive]}>
          <Text style={[styles.keyText, ctrl === 'armed' && styles.keyTextArmed, ctrl === 'locked' && styles.keyTextActive]}>CTRL</Text>
        </Pressable>
        <Pressable
          accessibilityState={{ selected: alt !== 'off' }}
          onPress={() => setAlt(value => value === 'off' ? 'armed' : 'off')}
          onLongPress={() => setAlt('locked')}
          delayLongPress={450}
          style={[styles.key, alt === 'armed' && styles.keyArmed, alt === 'locked' && styles.keyActive]}>
          <Text style={[styles.keyText, alt === 'armed' && styles.keyTextArmed, alt === 'locked' && styles.keyTextActive]}>ALT</Text>
        </Pressable>
        {KEYS.map(([labelText, value]) => (
          <Pressable key={labelText} onPress={() => sendInput(value)} style={styles.key}>
            <Text style={styles.keyText}>{labelText}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ink },
  hidden: { display: 'none' },
  statusBar: {
    height: 30,
    backgroundColor: colors.panel,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.acid },
  statusText: { color: colors.muted, fontFamily: 'monospace', fontSize: 9, letterSpacing: 1 },
  statusGrow: { flex: 1 },
  error: { color: colors.blocked, fontFamily: 'monospace', fontSize: 8 },
  compactError: { color: colors.blocked, backgroundColor: '#241211', paddingHorizontal: 8, paddingVertical: 4, fontFamily: 'monospace', fontSize: 8 },
  searchBar: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 5, backgroundColor: colors.panelRaised, borderBottomColor: colors.line, borderBottomWidth: 1 },
  searchInput: { minWidth: 100, flex: 1, height: 33, color: colors.text, backgroundColor: colors.ink, borderColor: colors.line, borderWidth: 1, paddingHorizontal: 9, fontFamily: 'monospace', fontSize: 10 },
  searchToggle: { width: 31, height: 31, alignItems: 'center', justifyContent: 'center' },
  searchToggleActive: { backgroundColor: colors.acid },
  searchToggleText: { color: colors.muted, fontFamily: 'monospace', fontSize: 9, fontWeight: '800' },
  searchToggleTextActive: { color: colors.ink },
  searchCount: { minWidth: 34, color: colors.muted, textAlign: 'center', fontFamily: 'monospace', fontSize: 8 },
  searchCountError: { color: colors.blocked },
  searchAction: { width: 28, height: 31, alignItems: 'center', justifyContent: 'center' },
  searchActionText: { color: colors.text, fontFamily: 'monospace', fontSize: 15 },
  webview: { flex: 1, backgroundColor: colors.ink },
  connectionOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, alignItems: 'center', justifyContent: 'center', padding: 30, backgroundColor: '#090b0af2' },
  connectionMark: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.working },
  connectionMarkError: { backgroundColor: colors.blocked },
  connectionTitle: { color: colors.text, fontFamily: 'monospace', fontSize: 13, fontWeight: '900', letterSpacing: 0.8, marginTop: 15, textAlign: 'center' },
  connectionCopy: { color: colors.muted, fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 8, maxWidth: 320 },
  connectionAttempt: { color: colors.acid, fontFamily: 'monospace', fontSize: 8, marginTop: 10 },
  connectionActions: { flexDirection: 'row', gap: 8, marginTop: 20 },
  retryButton: { backgroundColor: colors.acid, paddingHorizontal: 14, paddingVertical: 11 },
  retryText: { color: colors.ink, fontFamily: 'monospace', fontSize: 9, fontWeight: '900' },
  dismissButton: { borderColor: colors.line, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11 },
  dismissText: { color: colors.text, fontFamily: 'monospace', fontSize: 9, fontWeight: '800' },
  keyRail: {
    flexGrow: 0,
    backgroundColor: colors.panel,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  keyRailContent: { alignItems: 'center', paddingVertical: 6, paddingHorizontal: 5, gap: 4 },
  key: { minWidth: 48, paddingHorizontal: 9, paddingVertical: 8, alignItems: 'center', backgroundColor: colors.panelRaised, borderColor: colors.line, borderWidth: 1 },
  keyArmed: { borderColor: colors.acid, backgroundColor: '#29311e' },
  keyActive: { backgroundColor: colors.acid, borderColor: colors.acid },
  keyText: { color: colors.text, fontFamily: 'monospace', fontSize: 9, fontWeight: '700' },
  keyTextArmed: { color: colors.acid },
  keyTextActive: { color: colors.ink },
});
