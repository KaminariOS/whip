import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ChevronLeft, Ellipsis, Globe2, Plus, X } from 'lucide-react-native';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  PanResponder,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import WebView from 'react-native-webview/lib/WebView.android';

import { cn } from '@/src/lib/utils';
import { serverFocusMatchesPendingPane } from '@/src/lib/terminalFocus';
import { terminalWebLinkTarget } from '@/src/lib/terminalLinks';
import {
  neighborTabIndex,
  shouldCommitTerminalTabSwipe,
  terminalTabSwipeDirection,
  terminalTabSwipeOffset,
  type TerminalTabSwipeDirection,
} from '@/src/lib/terminalTabSwipe';
import type { TerminalControlId, TerminalControlUsage } from '../lib/terminalControls';
import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalSessionsState } from '../terminalSessions';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { TerminalPreferences } from '../services/devicePreferences';
import { sessionTabStatusColor, statusColor, useTheme } from '../theme';
import type { HerdrSnapshot, PaneInfo, TabInfo } from '../types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { TerminalScreen } from './TerminalScreen';

interface Props {
  visible: boolean;
  snapshot: HerdrSnapshot;
  client: HerdrClient;
  terminalState: TerminalSessionsState;
  onRefresh: () => Promise<void>;
  onOpenPane: (pane: PaneInfo) => void;
  onActivateTerminal: (pane: PaneInfo) => void;
  onCloseTerminal: (terminalId: string) => void;
  onTerminalStatus: (terminalId: string, status: TerminalSessionStatus, error?: string, reconnectAttempt?: number) => void;
  terminalPreferences: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
  onTerminalFontSizeChange: (fontSize: number) => void;
  onTerminalControlUse: (control: TerminalControlId) => void;
  onExit: () => void;
}

type EditorMode = 'tab' | 'rename-tab';
type PendingFocus = {
  mode: 'create' | 'close';
  previousId: string | null;
};

type TerminalTabSwipe = {
  direction: TerminalTabSwipeDirection;
  originTabId: string;
  originTerminalId: string | null;
  targetTabId: string;
  targetTerminalId: string | null;
  targetLabel: string;
};

interface BrowserWebViewHandle {
  goBack: () => void;
}

const BROWSER_WEBVIEW_STYLE = { flex: 1 } as const;

export function SessionScreen({
  visible,
  snapshot,
  client,
  terminalState,
  onRefresh,
  onOpenPane,
  onActivateTerminal,
  onCloseTerminal,
  onTerminalStatus,
  terminalPreferences,
  terminalControlUsage,
  onTerminalFontSizeChange,
  onTerminalControlUse,
  onExit,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const safeAreaInsets = useSafeAreaInsets();
  const focusedWorkspace = snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
  const [workspaceId, setWorkspaceId] = useState(focusedWorkspace?.workspace_id || '');
  const [tabId, setTabId] = useState(focusedWorkspace?.active_tab_id || '');
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [terminalSurfaceMounted, setTerminalSurfaceMounted] = useState(visible);
  const [terminalWidth, setTerminalWidth] = useState(0);
  const [tabSwipe, setTabSwipe] = useState<TerminalTabSwipe | null>(null);
  const [linkScanRequest, setLinkScanRequest] = useState(0);
  const [linksOpen, setLinksOpen] = useState(false);
  const [terminalLinks, setTerminalLinks] = useState<string[]>([]);
  const [linksBusy, setLinksBusy] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [browserDisplayUrl, setBrowserDisplayUrl] = useState('');
  const [browserCanGoBack, setBrowserCanGoBack] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const terminalWidthRef = useRef(0);
  const browserWebView = useRef<BrowserWebViewHandle | null>(null);
  const tunnelPortRef = useRef<number | null>(null);
  const browserRequestRef = useRef(0);
  const tabSwipeTranslateX = useRef(new Animated.Value(0)).current;
  const tabSwipeRef = useRef<TerminalTabSwipe | null>(null);
  const pendingPaneFocus = useRef<string | null>(null);
  const lastActivePaneId = useRef<string | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);

  useEffect(() => {
    if (visible) setTerminalSurfaceMounted(true);
  }, [visible]);

  const workspace = snapshot.workspaces.find(item => item.workspace_id === workspaceId) || focusedWorkspace;
  const tabs = snapshot.tabs.filter(item => item.workspace_id === workspace?.workspace_id);
  const selectedTab = tabs.find(item => item.tab_id === tabId) || tabs.find(item => item.focused) || tabs[0];
  const panes = snapshot.panes.filter(item => item.tab_id === selectedTab?.tab_id);
  const serverWorkspace = snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
  const serverTab = snapshot.tabs.find(item => (
    item.workspace_id === serverWorkspace?.workspace_id
      && item.tab_id === serverWorkspace.active_tab_id
  )) || snapshot.tabs.find(item => item.workspace_id === serverWorkspace?.workspace_id && item.focused);
  const serverPane = snapshot.panes.find(item => item.tab_id === serverTab?.tab_id && item.focused)
    || snapshot.panes.find(item => item.tab_id === serverTab?.tab_id);
  const serverWorkspaceId = serverWorkspace?.workspace_id || '';
  const serverTabId = serverTab?.tab_id || '';
  const serverPaneId = serverPane?.pane_id || '';
  const selectedPane = panes.find(item => item.terminal_id === terminalState.activeTerminalId)
    || panes.find(item => item.focused)
    || panes[0];
  const activeTerminalSession = terminalState.sessions.find(
    session => session.terminalId === terminalState.activeTerminalId,
  );

  const closeActiveTunnel = async () => {
    const localPort = tunnelPortRef.current;
    tunnelPortRef.current = null;
    if (localPort !== null) await client.closeWebTunnel(localPort).catch(() => undefined);
  };

  const scanTerminalLinks = () => {
    browserRequestRef.current += 1;
    setLinksOpen(true);
    setBrowserUrl(null);
    setTerminalLinks([]);
    setLinksError(null);
    setLinksBusy(true);
    closeActiveTunnel().catch(() => undefined);
    setLinkScanRequest(value => value + 1);
  };

  const dismissLinks = () => {
    browserRequestRef.current += 1;
    setLinksOpen(false);
    setBrowserUrl(null);
    setBrowserCanGoBack(false);
    closeActiveTunnel().catch(() => undefined);
  };

  const leaveBrowser = () => {
    browserRequestRef.current += 1;
    setBrowserUrl(null);
    setBrowserCanGoBack(false);
    setBrowserLoading(false);
    closeActiveTunnel().catch(() => undefined);
  };

  const openTerminalLink = async (value: string) => {
    const request = ++browserRequestRef.current;
    setLinksBusy(true);
    setLinksError(null);
    try {
      await closeActiveTunnel();
      const target = terminalWebLinkTarget(value);
      const tunnel = await client.openWebTunnel(target.url);
      if (request !== browserRequestRef.current) {
        if (tunnel) await client.closeWebTunnel(tunnel.localPort).catch(() => undefined);
        return;
      }
      if (tunnel) tunnelPortRef.current = tunnel.localPort;
      setBrowserDisplayUrl(target.url);
      setBrowserUrl(tunnel?.url || target.url);
      setBrowserCanGoBack(false);
      setBrowserLoading(true);
    } catch (reason) {
      if (request === browserRequestRef.current) setLinksError(String(reason));
    } finally {
      if (request === browserRequestRef.current) setLinksBusy(false);
    }
  };

  useEffect(() => () => {
    browserRequestRef.current += 1;
    const localPort = tunnelPortRef.current;
    tunnelPortRef.current = null;
    if (localPort !== null) client.closeWebTunnel(localPort).catch(() => undefined);
  }, [client]);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending) {
      const previousStillPresent = snapshot.tabs.some(item => item.tab_id === pending.previousId);
      const focusedServerWorkspace = snapshot.workspaces.find(item => item.focused) || workspace;
      const serverTabs = snapshot.tabs.filter(item => item.workspace_id === focusedServerWorkspace?.workspace_id);
      const nextTab = serverTabs.find(item => item.focused)
        || serverTabs.find(item => item.tab_id === focusedServerWorkspace?.active_tab_id)
        || serverTabs[0];
      const focusUnchanged = nextTab?.tab_id === pending.previousId;
      if ((pending.mode === 'create' && focusUnchanged) || (pending.mode === 'close' && previousStillPresent)) return;
      if (focusedServerWorkspace) setWorkspaceId(focusedServerWorkspace.workspace_id);
      setTabId(nextTab?.tab_id || '');
      pendingFocus.current = null;
      return;
    }
    if (workspace && workspace.workspace_id !== workspaceId) setWorkspaceId(workspace.workspace_id);
    if (selectedTab && selectedTab.tab_id !== tabId) setTabId(selectedTab.tab_id);
  }, [selectedTab, snapshot.tabs, snapshot.workspaces, tabId, workspace, workspaceId]);

  // Herdr owns focus. Follow focus changes made by the native or another remote client.
  useEffect(() => {
    if (!serverWorkspaceId || !serverTabId) return;
    if (!serverFocusMatchesPendingPane(serverPaneId, pendingPaneFocus.current)) return;
    setWorkspaceId(serverWorkspaceId);
    setTabId(serverTabId);
  }, [serverPaneId, serverTabId, serverWorkspaceId]);

  // Preserve an explicit terminal choice until Herdr confirms the same pane.
  useEffect(() => {
    if (!visible) {
      pendingPaneFocus.current = null;
      lastActivePaneId.current = null;
      return;
    }
    const activeSession = terminalState.sessions.find(item => item.terminalId === terminalState.activeTerminalId);
    const activePane = snapshot.panes.find(item => item.pane_id === activeSession?.paneId);
    if (!activePane || activePane.pane_id === lastActivePaneId.current) return;
    lastActivePaneId.current = activePane.pane_id;
    pendingPaneFocus.current = activePane.pane_id;
    setWorkspaceId(activePane.workspace_id);
    setTabId(activePane.tab_id);
  }, [snapshot.panes, terminalState.activeTerminalId, terminalState.sessions, visible]);

  const activateServerPane = useEffectEvent((paneId: string) => {
    const pane = snapshot.panes.find(item => item.pane_id === paneId);
    if (pane) onActivateTerminal(pane);
  });

  // A Herdr tab is a live terminal surface. Attach its server-focused pane immediately.
  useEffect(() => {
    if (!visible || !serverPaneId) return;
    if (!serverFocusMatchesPendingPane(serverPaneId, pendingPaneFocus.current)) return;
    pendingPaneFocus.current = null;
    activateServerPane(serverPaneId);
  }, [serverPaneId, visible]);

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      await onRefresh();
      return true;
    } catch (error) {
      Alert.alert(t('herd.commandFailed'), String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chooseTab = (item: TabInfo) => {
    setWorkspaceId(item.workspace_id);
    setTabId(item.tab_id);
    const nextPanes = snapshot.panes.filter(pane => pane.tab_id === item.tab_id);
    const nextPane = nextPanes.find(pane => pane.focused) || nextPanes[0];
    if (nextPane) onActivateTerminal(nextPane);
    run(async () => {
      if (item.workspace_id !== workspace?.workspace_id) await client.focusWorkspace(item.workspace_id);
      await client.focusTab(item.tab_id);
    });
  };

  const swipeContextRef = useRef({ tabs, selectedTab, activeTerminalSession, snapshot });
  swipeContextRef.current = { tabs, selectedTab, activeTerminalSession, snapshot };
  const chooseTabRef = useRef(chooseTab);
  chooseTabRef.current = chooseTab;

  const beginTabSwipe = (direction: TerminalTabSwipeDirection): TerminalTabSwipe | null => {
    const context = swipeContextRef.current;
    const currentIndex = context.tabs.findIndex(item => item.tab_id === context.selectedTab?.tab_id);
    const targetIndex = neighborTabIndex(currentIndex, context.tabs.length, direction);
    if (targetIndex === null || !context.selectedTab) return null;
    const target = context.tabs[targetIndex];
    const targetPanes = context.snapshot.panes.filter(pane => pane.tab_id === target.tab_id);
    const targetPane = targetPanes.find(pane => pane.focused) || targetPanes[0];
    const nextSwipe: TerminalTabSwipe = {
      direction,
      originTabId: context.selectedTab.tab_id,
      originTerminalId: context.activeTerminalSession?.terminalId || null,
      targetTabId: target.tab_id,
      targetTerminalId: targetPane?.terminal_id || null,
      targetLabel: target.label || target.tab_id,
    };
    tabSwipeRef.current = nextSwipe;
    setTabSwipe(nextSwipe);
    return nextSwipe;
  };

  const settleTabSwipe = (commit: boolean) => {
    const swipe = tabSwipeRef.current;
    if (!swipe) return;
    const destination = commit ? -swipe.direction * terminalWidthRef.current : 0;
    Animated.spring(tabSwipeTranslateX, {
      toValue: destination,
      damping: 24,
      stiffness: 240,
      mass: 0.8,
      overshootClamping: true,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || tabSwipeRef.current !== swipe) return;
      if (commit) {
        const target = swipeContextRef.current.tabs.find(item => item.tab_id === swipe.targetTabId);
        if (target) chooseTabRef.current(target);
      }
      tabSwipeRef.current = null;
      setTabSwipe(null);
      tabSwipeTranslateX.setValue(0);
    });
  };

  const terminalTabPanResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => {
      const direction = terminalTabSwipeDirection(
        gesture.dx,
        gesture.dy,
        gesture.numberActiveTouches,
      );
      if (!direction || terminalWidthRef.current <= 0) return false;
      const context = swipeContextRef.current;
      const currentIndex = context.tabs.findIndex(item => item.tab_id === context.selectedTab?.tab_id);
      return neighborTabIndex(currentIndex, context.tabs.length, direction) !== null;
    },
    onPanResponderMove: (_event, gesture) => {
      const direction = tabSwipeRef.current?.direction
        || terminalTabSwipeDirection(gesture.dx, gesture.dy, gesture.numberActiveTouches);
      if (!direction) return;
      const swipe = tabSwipeRef.current || beginTabSwipe(direction);
      if (!swipe) return;
      tabSwipeTranslateX.setValue(terminalTabSwipeOffset(
        gesture.dx,
        terminalWidthRef.current,
        swipe.direction,
      ));
    },
    onPanResponderRelease: (_event, gesture) => {
      const swipe = tabSwipeRef.current;
      if (!swipe) return;
      settleTabSwipe(shouldCommitTerminalTabSwipe(
        gesture.dx,
        gesture.vx,
        terminalWidthRef.current,
        swipe.direction,
      ));
    },
    onPanResponderTerminate: () => settleTabSwipe(false),
    onPanResponderTerminationRequest: () => false,
  })).current;

  useEffect(() => {
    if (visible) return;
    tabSwipeRef.current = null;
    setTabSwipe(null);
    tabSwipeTranslateX.stopAnimation();
    tabSwipeTranslateX.setValue(0);
  }, [tabSwipeTranslateX, visible]);

  const choosePane = (pane: PaneInfo) => {
    onActivateTerminal(pane);
    run(() => client.focusPane(pane.pane_id));
  };

  const create = async () => {
    let succeeded = true;
    if (editorMode === 'rename-tab' && selectedTab) {
      succeeded = await run(() => client.renameTab(selectedTab.tab_id, name));
    } else if (workspace) {
      pendingFocus.current = {
        mode: 'create',
        previousId: snapshot.tabs.find(item => item.focused)?.tab_id || selectedTab?.tab_id || null,
      };
      succeeded = await run(() => client.createTab(workspace.workspace_id, name));
    }
    if (!succeeded) pendingFocus.current = null;
    setName('');
    setEditorMode(null);
  };

  const openRenameTab = () => {
    if (!selectedTab) return;
    setName(selectedTab.label);
    setEditorMode('rename-tab');
    setMenuOpen(false);
  };

  const closeTab = async (item: TabInfo | undefined = selectedTab) => {
    if (!item) return;
    setMenuOpen(false);
    pendingFocus.current = { mode: 'close', previousId: item.tab_id };
    if (!await run(() => client.closeTab(item.tab_id))) pendingFocus.current = null;
  };

  return (
    <View
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible ? 'auto' : 'none'}
      className={cn('flex-1 bg-terminal-canvas', !visible && 'absolute inset-0 opacity-0')}>
      <View className="h-[42px] flex-row border-b border-border bg-background">
        <Button accessibilityLabel={t('session.backToHerd')} className="h-[42px] w-[42px] rounded-none px-0" variant="ghost" onPress={hapticPress(onExit)}>
          <ChevronLeft size={21} color={colors.text} />
        </Button>
        {workspace ? (
          <>
            <ScrollView className="min-w-0 flex-1" horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center px-1.5 gap-[5px]">
              {tabs.map(item => {
                const active = item.tab_id === selectedTab?.tab_id;
                const itemPanes = snapshot.panes.filter(pane => pane.tab_id === item.tab_id);
                const itemSession = terminalState.sessions.find(session => itemPanes.some(pane => pane.terminal_id === session.terminalId));
                const label = item.label || item.tab_id;
                return (
                  <View key={item.tab_id} className={cn('h-[30px] max-w-[170px] flex-row items-center overflow-hidden rounded-full bg-muted', active && 'bg-primary')}>
                    <Button accessibilityLabel={t('session.openTab', { tab: label })} className="h-[30px] min-w-0 flex-shrink justify-start gap-2 rounded-none px-[11px] py-0 pr-1" variant="ghost" onPress={hapticPress(() => chooseTab(item))} onLongPress={active ? openRenameTab : undefined}>
                      <AnimatedAgentStatusGlyph status={item.agent_status} color={sessionTabStatusColor(item.agent_status, itemSession?.status, colors)} size={12} />
                      <Text numberOfLines={1} className={cn('max-w-[94px] pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', active && 'text-primary-foreground')}>{label}</Text>
                      {item.pane_count > 1 && <Text className={cn('font-mono text-[8px] text-muted-foreground', active && 'text-primary-foreground')}>{item.pane_count}</Text>}
                    </Button>
                    <Button accessibilityLabel={t('session.closeTab', { tab: label })} className="h-[30px] w-7 rounded-none px-0" variant="ghost" onPress={hapticPress(() => closeTab(item))}>
                      <X size={14} color={active ? colors.onPrimary : colors.textSecondary} />
                    </Button>
                  </View>
                );
              })}
            </ScrollView>
            <Button accessibilityLabel={t('session.newTab')} className="h-[42px] w-11 rounded-none px-0" disabled={busy} variant="ghost" onPress={hapticPress(() => setEditorMode('tab'))}><Plus size={16} color={colors.text} /></Button>
            <Button accessibilityLabel={t('session.actions')} className="h-[42px] w-11 rounded-none px-0" variant="ghost" onPress={hapticPress(() => setMenuOpen(value => !value))}>
              <Ellipsis size={18} color={colors.text} />
            </Button>
            <Button
              accessibilityLabel={t('terminal.scanLinks')}
              className="h-[42px] w-11 rounded-none px-0"
              disabled={!activeTerminalSession || activeTerminalSession.status !== 'connected'}
              variant="ghost"
              onPress={hapticPress(scanTerminalLinks)}>
              <Globe2 size={18} color={colors.text} />
            </Button>
          </>
        ) : null}
      </View>

      {menuOpen && (
        <View className="min-h-[42px] flex-row items-stretch border-b border-border bg-background">
          <MenuAction label={t('session.renameTab')} disabled={!selectedTab} onPress={openRenameTab} />
          <MenuAction label={t('session.paneActions')} disabled={!selectedPane} onPress={() => { if (selectedPane) onOpenPane(selectedPane); setMenuOpen(false); }} />
          <MenuAction label={t('session.closeTabAction')} danger disabled={!selectedTab} onPress={closeTab} />
        </View>
      )}

      {editorMode && (
        <View className="flex-row items-center gap-1.5 border-b border-border bg-card p-[7px]">
          <Text className="font-mono text-[8px] text-foreground">{editorMode.startsWith('rename') ? t('herd.rename') : t('herd.new')} {t('session.tab')}</Text>
          <Input className="h-[34px] min-w-[110px] flex-1 rounded-none px-2 font-mono text-[10px]" value={name} onChangeText={setName} placeholder={t('herd.labelOptional')} placeholderTextColor={colors.textTertiary} />
          <Button className="h-[34px] rounded-none px-2" variant="ghost" onPress={hapticPress(() => setEditorMode(null))}><Text className="font-mono text-[8px] text-muted-foreground">{t('common.cancel')}</Text></Button>
          <Button className="h-[34px] rounded-none px-2" onPress={hapticPress(create)}><Text className="font-mono text-[8px] font-black">{t('common.save')}</Text></Button>
        </View>
      )}

      {selectedTab && panes.length > 1 && (
        <View className="h-[37px] flex-row border-b border-border bg-background">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center px-1.5 gap-[5px]">
            {panes.map(pane => {
              const active = pane.terminal_id === selectedPane?.terminal_id;
              return (
                <Button key={pane.pane_id} className={cn('h-7 max-w-40 rounded-full bg-muted px-2.5', active && 'bg-primary')} variant="ghost" onPress={hapticPress(() => choosePane(pane))} onLongPress={() => onOpenPane(pane)}><View className="size-[5px] rounded-full" style={{ backgroundColor: statusColor(pane.agent_status, colors) }} /><Text numberOfLines={1} className={cn('max-w-[126px] text-[11px] font-semibold text-muted-foreground', active && 'text-primary-foreground')}>{pane.label || pane.display_agent || pane.agent || 'shell'}</Text></Button>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View
        className="relative flex-1 overflow-hidden bg-terminal-canvas"
        onLayout={event => {
          terminalWidthRef.current = event.nativeEvent.layout.width;
          setTerminalWidth(event.nativeEvent.layout.width);
        }}>
        {terminalSurfaceMounted && terminalState.sessions.map(terminalSession => {
          // Fabric merges native-driver transform patches with React props. Keep
          // transform array-shaped even after a swipe ends; changing it to null
          // trips SurfaceMountingManager's synchronous-prop assertion.
          const translateX = tabSwipe?.originTerminalId === terminalSession.terminalId
            ? tabSwipeTranslateX
            : tabSwipe?.targetTerminalId === terminalSession.terminalId
              ? Animated.add(tabSwipeTranslateX, tabSwipe.direction * terminalWidth)
              : 0;
          return (
            <Animated.View
              key={terminalSession.terminalId}
              pointerEvents="box-none"
              style={[
                StyleSheet.absoluteFill,
                { transform: [{ translateX }] },
              ]}>
              <TerminalScreen
                client={client}
                compact
                visible={visible && terminalSession.terminalId === activeTerminalSession?.terminalId}
                preview={tabSwipe?.targetTerminalId === terminalSession.terminalId}
                terminalPanHandlers={terminalSession.terminalId === activeTerminalSession?.terminalId
                  ? terminalTabPanResponder.panHandlers
                  : undefined}
                session={terminalSession}
                scroll={snapshot.panes.find(pane => pane.terminal_id === terminalSession.terminalId)?.scroll}
                preferences={terminalPreferences}
                controlUsage={terminalControlUsage}
                linkScanRequest={linkScanRequest}
                onLinksScanned={links => {
                  if (terminalSession.terminalId !== activeTerminalSession?.terminalId) return;
                  setTerminalLinks(links);
                  setLinksBusy(false);
                }}
                onFontSizeChange={onTerminalFontSizeChange}
                onControlUse={onTerminalControlUse}
                onClose={() => onCloseTerminal(terminalSession.terminalId)}
                onStatus={(status, error, reconnectAttempt) => {
                  onTerminalStatus(terminalSession.terminalId, status, error, reconnectAttempt);
                }}
              />
            </Animated.View>
          );
        })}
        {tabSwipe
          && (!tabSwipe.targetTerminalId
            || !terminalState.sessions.some(session => session.terminalId === tabSwipe.targetTerminalId))
          && (
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                {
                  transform: [{
                    translateX: Animated.add(
                      tabSwipeTranslateX,
                      tabSwipe.direction * terminalWidth,
                    ),
                  }],
                },
              ]}
              className="items-center justify-center bg-terminal-canvas p-[30px]">
              <Text className="font-mono text-[10px] font-black text-terminal-text">{tabSwipe.targetLabel}</Text>
            </Animated.View>
          )}
        {!selectedTab && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-mono font-black text-terminal-text">{workspace ? t('session.emptyWorkspace') : t('session.noWorkspaces')}</Text>
            <Text className="mt-2 text-center text-terminal-muted">{workspace ? t('session.createTab') : t('session.createWorkspace')}</Text>
          </View>
        )}
        {selectedTab && panes.length === 0 && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-mono font-black text-terminal-text">{t('session.emptyTab')}</Text>
            <Text className="mt-2 text-center text-terminal-muted">{t('session.emptyTabCopy')}</Text>
          </View>
        )}
        <Modal
          animationType="slide"
          onRequestClose={browserUrl ? leaveBrowser : dismissLinks}
          statusBarTranslucent
          visible={linksOpen}>
          <View
            className="flex-1 bg-background"
            style={{ paddingTop: safeAreaInsets.top, paddingBottom: safeAreaInsets.bottom }}>
            {browserUrl ? (
              <>
                <View className="h-12 flex-row items-center border-b border-border bg-background">
                  <Button
                    accessibilityLabel={t('terminal.browserBack')}
                    className="h-12 w-12 rounded-none px-0"
                    variant="ghost"
                    onPress={() => browserCanGoBack ? browserWebView.current?.goBack() : leaveBrowser()}>
                    <ChevronLeft size={21} color={colors.text} />
                  </Button>
                  <View className="min-w-0 flex-1 px-1">
                    <Text numberOfLines={1} className="text-[11px] font-semibold text-foreground">{terminalWebLinkTarget(browserDisplayUrl).hostname}</Text>
                    <Text numberOfLines={1} className="font-mono text-[8px] text-muted-foreground">{browserDisplayUrl}</Text>
                  </View>
                  <Button accessibilityLabel={t('terminal.closeBrowser')} className="h-12 w-12 rounded-none px-0" variant="ghost" onPress={dismissLinks}>
                    <X size={19} color={colors.text} />
                  </Button>
                </View>
                <View className="relative flex-1 bg-white">
                  <WebView
                    ref={value => { browserWebView.current = value as BrowserWebViewHandle | null; }}
                    source={{ uri: browserUrl }}
                    javaScriptEnabled
                    onLoadStart={() => setBrowserLoading(true)}
                    onLoadEnd={() => setBrowserLoading(false)}
                    onNavigationStateChange={state => setBrowserCanGoBack(state.canGoBack)}
                    style={BROWSER_WEBVIEW_STYLE}
                  />
                  {browserLoading && (
                    <View pointerEvents="none" className="absolute inset-x-0 top-0 items-center py-2">
                      <ActivityIndicator color={colors.primary} />
                    </View>
        )}
                </View>
              </>
            ) : (
              <>
                <View className="h-14 flex-row items-center border-b border-border px-4">
                  <View className="min-w-0 flex-1">
                    <Text className="text-[17px] font-bold text-foreground">{t('terminal.linksTitle')}</Text>
                    <Text className="font-mono text-[8px] uppercase tracking-[1px] text-muted-foreground">{t('terminal.linksLatestFirst')}</Text>
                  </View>
                  <Button accessibilityLabel={t('terminal.closeLinks')} className="size-11 rounded-full px-0" variant="ghost" onPress={dismissLinks}>
                    <X size={19} color={colors.text} />
                  </Button>
                </View>
                {linksBusy ? (
                  <View className="flex-1 items-center justify-center gap-3 p-8">
                    <ActivityIndicator color={colors.primary} />
                    <Text className="text-[12px] text-muted-foreground">{t('terminal.scanningLinks')}</Text>
                  </View>
                ) : linksError ? (
                  <View className="flex-1 items-center justify-center p-8">
                    <Text className="text-center text-[13px] font-semibold text-destructive">{t('terminal.linkOpenFailed')}</Text>
                    <Text className="mt-2 text-center font-mono text-[9px] text-muted-foreground">{linksError}</Text>
                  </View>
                ) : terminalLinks.length ? (
                  <ScrollView className="flex-1" contentContainerClassName="px-4 py-2">
                    {terminalLinks.map((link, index) => {
                      const target = terminalWebLinkTarget(link);
                      return (
                        <Button
                          key={`${link}-${index}`}
                          className="h-auto min-h-[66px] flex-row justify-start gap-3 rounded-none border-b border-border px-0 py-3"
                          variant="ghost"
                          onPress={() => openTerminalLink(link)}>
                          <View className="size-9 items-center justify-center rounded-full bg-muted">
                            <Globe2 size={17} color={colors.text} />
                          </View>
                          <View className="min-w-0 flex-1 items-start">
                            <View className="flex-row items-center gap-2">
                              <Text numberOfLines={1} className="max-w-[220px] text-[12px] font-bold text-foreground">{target.hostname}</Text>
                              {target.requiresSshTunnel && (
                                <Text className="rounded-full bg-primary px-2 py-0.5 font-mono text-[7px] font-black text-primary-foreground">{t('terminal.sshTunnel')}</Text>
                              )}
                            </View>
                            <Text numberOfLines={2} className="mt-1 text-left font-mono text-[9px] leading-[13px] text-muted-foreground">{link}</Text>
                          </View>
                        </Button>
                      );
                    })}
                  </ScrollView>
                ) : (
                  <View className="flex-1 items-center justify-center p-8">
                    <Globe2 size={28} color={colors.textSecondary} />
                    <Text className="mt-3 text-[14px] font-semibold text-foreground">{t('terminal.noLinks')}</Text>
                    <Text className="mt-1 text-center text-[11px] text-muted-foreground">{t('terminal.noLinksCopy')}</Text>
                  </View>
                )}
              </>
            )}
          </View>
        </Modal>
      </View>
    </View>
  );
}

function MenuAction({ label, onPress, disabled = false, danger = false }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Button className="h-auto min-w-0 flex-1 rounded-none border-r border-border px-1" disabled={disabled} variant="ghost" onPress={hapticPress(onPress)}><Text className={cn('text-center text-[9px] font-semibold text-foreground', danger && 'text-destructive')}>{label}</Text></Button>
  );
}
