import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { ChevronLeft, Globe2, Plus, SquareTerminal, X } from 'lucide-react-native';
import {
  ActivityIndicator,
  Linking,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import WebView from 'react-native-webview';

import { orderByAgentStatusPriority, tabAgentStateChangeSequence } from '@/src/herdQueue';
import { DEFAULT_SPRING_CONFIG } from '@/src/lib/motion';
import { runWithInFlightGuard } from '@/src/lib/inFlightSubmission';
import { cn } from '@/src/lib/utils';
import {
  activateCreatedTabLocally,
  serverFocusMatchesPendingPane,
  shouldFollowServerTerminalFocus,
} from '@/src/lib/terminalFocus';
import { terminalWebLinkTarget } from '@/src/lib/terminalLinks';
import { resolveTranscriptFilePath, type TranscriptFileLinkTarget } from '@/src/lib/transcriptLinks';
import {
  neighborTabIndex,
  shouldCommitTerminalTabSwipe,
  terminalTabSwipeDirection,
  terminalTabSwipeOffset,
  type TerminalTabSwipeDirection,
} from '@/src/lib/terminalTabSwipe';
import type { TerminalRenderTarget } from '@/src/lib/terminalRenderer';
import { resolveTerminalVolumeKeyAction, type TerminalVolumeKey } from '@/src/lib/volumeKeys';
import type { TerminalControlId, TerminalControlUsage } from '../lib/terminalControls';
import { chatAgentForPane, openCodeSessionIdForPane, type ChatAgent } from '../lib/agentChatSession';
import { codexChatAction, codexMissingIdentityAction, codexSessionIdForPane, type CodexIntegrationStatus } from '../lib/codexSession';
import { emptyTranscript, type AgentChatState } from '../agentChat';
import type { HerdrClient } from '../services/HerdrClient';
import { codexTranscriptService } from '../services/CodexTranscriptService';
import { openCodeTranscriptService } from '../services/OpenCodeTranscriptService';
import { terminalTabSelectionStarted } from '../services/performanceTrace';
import type { TerminalSessionsState } from '../terminalSessions';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { TerminalPreferences } from '../services/devicePreferences';
import { addTerminalVolumeKeyListener } from '../services/volumeKeys';
import { sessionTabGlassStyle, sessionTabStatusColor, statusColor, useTheme } from '../theme';
import type { HerdrSnapshot, PaneInfo, TabInfo } from '../types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
import { AgentIdentityWarningSheet, type AgentIdentityWarning } from './AgentIdentityWarningSheet';
import { AppAlertPopup, type AppAlertContent } from './AppAlertPopup';
import { AppBackground } from './AppBackground';
import { AttachmentPasteSheet, type PastedAttachment } from './AttachmentPasteSheet';
import { CodexIntegrationInstallSheet } from './CodexIntegrationInstallSheet';
import { ResourceEditorField, ResourceEditorSheet } from './ResourceEditorSheet';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Text } from './ui/text';
import {
  TerminalBackground,
  TerminalScreen,
} from './TerminalScreen';
import { AgentChatView } from './AgentChatView';
import { useAppGlassEnabled } from './GlassSurface';

interface Props {
  hostSessionId: string;
  visible: boolean;
  snapshot: HerdrSnapshot;
  client: HerdrClient;
  terminalState: TerminalSessionsState;
  terminalTargets: readonly TerminalRenderTarget[];
  appBackgroundImageUri: string | null;
  appBackgroundDimming: number;
  latencyMs: number | null;
  latencyWarningActive: boolean;
  onRefresh: () => Promise<void>;
  onOpenPane: (pane: PaneInfo) => void;
  onActivateTerminal: (pane: PaneInfo) => void;
  onCloseTerminal: (terminalId: string) => void;
  onTerminalStatus: (
    hostSessionId: string,
    terminalId: string,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => void;
  onTerminalFontSizeChange: (hostSessionId: string, terminalId: string, fontSize: number) => void;
  terminalPreferences: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
  terminalHistory: readonly string[];
  onOpenFiles: (terminalId: string, target?: TranscriptFileLinkTarget) => void;
  getComposerDraft: (terminalId: string) => string;
  onComposerDraftChange: (terminalId: string, value: string) => void;
  onTerminalControlUse: (control: TerminalControlId) => void;
  onTerminalHistoryEntry: (entry: string) => void;
  onTerminalOpenLinksInAppChange: (value: boolean) => void;
  onInteraction: (tabId: string) => void;
  onExit: () => void;
}

type EditorMode = 'tab' | 'rename-tab' | 'rename-pane';
type PendingFocus = {
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

interface OpenChatView {
  agent: ChatAgent;
  key: string | null;
  state: AgentChatState;
}

const BROWSER_WEBVIEW_STYLE = { flex: 1 } as const;

function loadingChatState(sessionId: string): AgentChatState {
  return { sessionId, transcript: emptyTranscript(sessionId), status: 'loading' };
}

export function SessionScreen({
  hostSessionId,
  visible,
  snapshot,
  client,
  terminalState,
  terminalTargets,
  appBackgroundImageUri,
  appBackgroundDimming,
  latencyMs,
  latencyWarningActive,
  onRefresh,
  onActivateTerminal,
  onCloseTerminal,
  onTerminalStatus,
  onTerminalFontSizeChange,
  terminalPreferences,
  terminalControlUsage,
  terminalHistory,
  onOpenFiles,
  getComposerDraft,
  onComposerDraftChange,
  onTerminalControlUse,
  onTerminalHistoryEntry,
  onTerminalOpenLinksInAppChange,
  onInteraction,
  onExit,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const appGlassEnabled = useAppGlassEnabled();
  const safeAreaInsets = useSafeAreaInsets();
  const isIpad = Platform.OS === 'ios' && Platform.isPad;
  const focusedWorkspace = snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
  const [workspaceId, setWorkspaceId] = useState(focusedWorkspace?.workspace_id || '');
  const [tabId, setTabId] = useState(focusedWorkspace?.active_tab_id || '');
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [editingPaneId, setEditingPaneId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [appAlert, setAppAlert] = useState<AppAlertContent | null>(null);
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
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachmentTerminalId, setAttachmentTerminalId] = useState<string | null>(null);
  const [chatViews, setChatViews] = useState(() => new Map<string, OpenChatView>());
  const [pendingIntegrationPaneId, setPendingIntegrationPaneId] = useState<string | null>(null);
  const [agentIdentityWarning, setAgentIdentityWarning] = useState<AgentIdentityWarning | null>(null);
  const [codexIntegrationInstalling, setCodexIntegrationInstalling] = useState(false);
  const [codexHistoryWarmup, setCodexHistoryWarmup] = useState<{
    key: string;
    sessionId: string;
    terminalId: string;
  } | null>(null);
  const [codexIntegrationPrompt, setCodexIntegrationPrompt] = useState<{
    paneId: string;
    status: Extract<CodexIntegrationStatus, 'not-installed' | 'outdated' | 'needs-repair'>;
  } | null>(null);
  const [pasteRequest, setPasteRequest] = useState<{
    id: number;
    terminalId: string;
    text: string;
    previewUri: string | null;
    dispose: () => void;
  } | null>(null);
  const terminalWidthRef = useRef(0);
  const browserWebView = useRef<BrowserWebViewHandle | null>(null);
  const tunnelPreviewRef = useRef<string | null>(null);
  const browserRequestRef = useRef(0);
  const tabSwipeTranslateX = useSharedValue(0);
  const tabSwipeRef = useRef<TerminalTabSwipe | null>(null);
  const pendingPaneFocus = useRef<string | null>(null);
  const lastActivePaneId = useRef<string | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const codexIntegrationInstallingRef = useRef(false);
  const codexIntegrationInstallRequestRef = useRef(0);
  const chatViewsRef = useRef(chatViews);
  const mutationInFlight = useRef(false);

  const showAppAlert = useCallback((title: string, error: unknown) => {
    setAppAlert({ title, message: String(error) });
  }, []);

  const showHerdrError = useCallback((error: unknown) => {
    showAppAlert(t('herd.commandFailed'), error);
  }, [showAppAlert, t]);

  useEffect(() => () => cancelAnimation(tabSwipeTranslateX), [tabSwipeTranslateX]);

  const workspace = snapshot.workspaces.find(item => item.workspace_id === workspaceId) || focusedWorkspace;
  const tabs = orderByAgentStatusPriority(
    snapshot.tabs.filter(item => item.workspace_id === workspace?.workspace_id),
    item => item.agent_status,
    item => tabAgentStateChangeSequence(item, snapshot.agents),
  );
  const selectedTab = tabs.find(item => item.tab_id === tabId) || tabs.find(item => item.focused) || tabs[0];
  const editorTitle = editorMode === 'rename-tab'
    ? t('session.renameTab')
    : editorMode === 'rename-pane'
      ? t('session.renamePane')
      : t('session.newTab');
  const editorContext = editorMode === 'rename-pane'
    ? selectedTab?.label || selectedTab?.tab_id
    : workspace?.label || workspace?.workspace_id;
  const panes = snapshot.panes.filter(item => item.tab_id === selectedTab?.tab_id);
  const topOverlayInset = 55 + (selectedTab && panes.length > 1 ? 37 : 0);
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
  const activePane = snapshot.panes.find(pane => pane.terminal_id === activeTerminalSession?.terminalId);
  const activeChatAgent = chatAgentForPane(activePane);
  const activeChatView = activeTerminalSession && activeChatAgent
    ? chatViews.get(activeTerminalSession.terminalId) || null
    : null;
  const codexChatLoading = activeChatAgent === 'codex' && (
    codexIntegrationInstalling
    || pendingIntegrationPaneId === activePane?.pane_id
    || codexHistoryWarmup?.terminalId === activeTerminalSession?.terminalId
  );
  const followServerFocus = shouldFollowServerTerminalFocus(
    visible,
    activePane?.pane_id || null,
  );
  const chatVisible = Boolean(activeChatView);
  const chatViewIdentity = [...chatViews.entries()]
    .map(([terminalId, view]) => `${terminalId}:${view.agent}:${view.key || ''}:${view.state.sessionId}:${view.state.status}`)
    .sort()
    .join('|');
  const chatSubscriptionIdentity = [...chatViews.entries()]
    .map(([terminalId, view]) => `${terminalId}:${view.agent}:${view.key || ''}`)
    .sort()
    .join('|');
  chatViewsRef.current = chatViews;
  const activeTarget = terminalTargets.find(target => (
    target.hostSessionId === hostSessionId
      && target.session.terminalId === activeTerminalSession?.terminalId
  )) || null;
  const previewTarget = terminalTargets.find(target => (
    target.hostSessionId === hostSessionId
      && target.session.terminalId === tabSwipe?.targetTerminalId
  )) || null;
  const activeSwipeNeedsPlaceholder = Boolean(tabSwipe && !previewTarget);
  const activeTerminalSwipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: activeSwipeNeedsPlaceholder ? tabSwipeTranslateX.value : 0 }],
  }), [activeSwipeNeedsPlaceholder]);
  const previewPlaceholderStyle = useAnimatedStyle(() => ({
    transform: [{
      translateX: tabSwipeTranslateX.value + (tabSwipe ? tabSwipe.direction * terminalWidth : 0),
    }],
  }), [tabSwipe, terminalWidth]);

  const registerInteraction = (target: TerminalRenderTarget | null = activeTarget) => {
    if (!target || target.session.kind === 'ssh') return;
    const pane = snapshot.panes.find(item => item.pane_id === target.session.paneId);
    const interactionTabId = pane?.tab_id || selectedTab?.tab_id;
    if (interactionTabId) onInteraction(interactionTabId);
  };

  const closeActiveTunnel = async () => {
    const previewId = tunnelPreviewRef.current;
    tunnelPreviewRef.current = null;
    if (previewId !== null) await client.closeWebTunnel(previewId).catch(() => undefined);
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
      if (!terminalPreferences.openLinksInApp) {
        await Linking.openURL(target.url);
        return;
      }
      const tunnel = await client.openWebTunnel(target.url);
      if (request !== browserRequestRef.current) {
        if (tunnel) await client.closeWebTunnel(tunnel.previewId).catch(() => undefined);
        return;
      }
      if (tunnel) tunnelPreviewRef.current = tunnel.previewId;
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
    const previewId = tunnelPreviewRef.current;
    tunnelPreviewRef.current = null;
    if (previewId !== null) client.closeWebTunnel(previewId).catch(() => undefined);
  }, [client]);

  useEffect(() => {
    pendingPaneFocus.current = null;
    lastActivePaneId.current = null;
    pendingFocus.current = null;
    browserRequestRef.current += 1;
    setEditorMode(null);
    setEditingPaneId(null);
    setAppAlert(null);
    setLinksOpen(false);
    setBrowserUrl(null);
    setBrowserCanGoBack(false);
    setBrowserLoading(false);
    setAttachmentsOpen(false);
    setPasteRequest(null);
    setChatViews(new Map());
    setPendingIntegrationPaneId(null);
    setAgentIdentityWarning(null);
    setCodexHistoryWarmup(null);
    codexIntegrationInstallRequestRef.current += 1;
    codexIntegrationInstallingRef.current = false;
    setCodexIntegrationInstalling(false);
    setCodexIntegrationPrompt(null);
  }, [hostSessionId]);

  useEffect(() => () => {
    for (const [terminalId, view] of chatViewsRef.current) {
      const service = view.agent === 'codex'
        ? codexTranscriptService
        : openCodeTranscriptService;
      service.closeTerminal(hostSessionId, terminalId, view.key ?? undefined);
    }
  }, [hostSessionId]);

  useEffect(() => {
    const terminalIds = terminalState.sessions.map(session => session.terminalId);
    const liveTerminalIds = new Set(terminalIds);
    const nextViews = new Map(chatViewsRef.current);
    let changed = false;
    for (const [terminalId, view] of nextViews) {
      const previousService = view.agent === 'codex'
        ? codexTranscriptService
        : openCodeTranscriptService;
      if (!liveTerminalIds.has(terminalId)) {
        previousService.closeTerminal(hostSessionId, terminalId, view.key ?? undefined);
        nextViews.delete(terminalId);
        changed = true;
        continue;
      }
      const pane = snapshot.panes.find(item => item.terminal_id === terminalId);
      const nextAgent = chatAgentForPane(pane);
      if (!nextAgent) {
        previousService.closeTerminal(hostSessionId, terminalId, view.key ?? undefined);
        nextViews.delete(terminalId);
        changed = true;
        continue;
      }
      const sessionId = nextAgent === 'codex'
        ? codexSessionIdForPane(pane)
        : openCodeSessionIdForPane(pane);
      if (sessionId && (sessionId !== view.state.sessionId || nextAgent !== view.agent)) {
        previousService.closeTerminal(hostSessionId, terminalId, view.key ?? undefined);
        const service = nextAgent === 'codex' ? codexTranscriptService : openCodeTranscriptService;
        const key = service.activate(hostSessionId, terminalId, sessionId, client);
        nextViews.set(terminalId, {
          agent: nextAgent,
          key,
          state: service.getState(key) || loadingChatState(sessionId),
        });
        changed = true;
      } else if (!sessionId && view.state.status !== 'unavailable') {
        previousService.closeTerminal(hostSessionId, terminalId, view.key ?? undefined);
        nextViews.set(terminalId, {
          agent: nextAgent,
          key: null,
          state: {
            sessionId: '',
            transcript: emptyTranscript(''),
            status: 'unavailable',
            error: 'This pane no longer reports a supported native agent session ID.',
          },
        });
        changed = true;
      }
    }
    if (changed) setChatViews(nextViews);
  }, [chatViewIdentity, client, hostSessionId, snapshot.panes, terminalState.sessions]);

  useEffect(() => {
    const subscriptions = [...chatViewsRef.current.entries()].flatMap(([terminalId, view]) => {
      if (!view.key) return [];
      const service = view.agent === 'codex' ? codexTranscriptService : openCodeTranscriptService;
      return [service.subscribe(view.key, state => {
        setChatViews(current => {
          const active = current.get(terminalId);
          if (!active || active.key !== view.key || active.state === state) return current;
          const next = new Map(current);
          next.set(terminalId, { ...active, state });
          return next;
        });
      })];
    });
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, [chatSubscriptionIdentity]);

  useEffect(() => {
    if (!codexHistoryWarmup) return undefined;
    const { key, sessionId, terminalId } = codexHistoryWarmup;
    return codexTranscriptService.subscribe(key, state => {
      if (state.status === 'loading' || state.status === 'error') return;
      setCodexHistoryWarmup(current => current?.key === key ? null : current);
      const pane = snapshot.panes.find(item => item.terminal_id === terminalId);
      const stillMatches = codexSessionIdForPane(pane) === sessionId;
      if ((state.status === 'live' || state.status === 'stale') && stillMatches) {
        setChatViews(current => {
          const next = new Map(current);
          next.set(terminalId, { agent: 'codex', key, state });
          return next;
        });
        return;
      }
      if (state.status === 'unavailable' && stillMatches) {
        setAgentIdentityWarning({
          agent: 'codex',
          title: 'Codex history unavailable',
          message: state.error || 'Codex has not created a local rollout history for this session yet.',
        });
      }
    });
  }, [codexHistoryWarmup, snapshot.panes]);

  useEffect(() => {
    if (!pendingIntegrationPaneId) return;
    const pane = snapshot.panes.find(item => item.pane_id === pendingIntegrationPaneId);
    setPendingIntegrationPaneId(null);
    const sessionId = codexSessionIdForPane(pane);
    if (pane && sessionId) {
      const key = codexTranscriptService.activate(hostSessionId, pane.terminal_id, sessionId, client);
      if (codexTranscriptService.hasCachedHistory(key)) {
        setChatViews(current => {
          const next = new Map(current);
          next.set(pane.terminal_id, {
            agent: 'codex',
            key,
            state: codexTranscriptService.getState(key) || loadingChatState(sessionId),
          });
          return next;
        });
      } else {
        setCodexHistoryWarmup({ key, sessionId, terminalId: pane.terminal_id });
      }
    } else {
      setAgentIdentityWarning({
        agent: 'codex',
        title: 'Restart Codex to enable Chat',
        message: 'The Herdr Codex integration is installed, but this already-running Codex process has no native session identity. Restart Codex in this pane, then tap Chat again.',
      });
    }
  }, [client, hostSessionId, pendingIntegrationPaneId, snapshot.panes]);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending) {
      const previousStillPresent = snapshot.tabs.some(item => item.tab_id === pending.previousId);
      const focusedServerWorkspace = snapshot.workspaces.find(item => item.focused) || workspace;
      const serverTabs = snapshot.tabs.filter(item => item.workspace_id === focusedServerWorkspace?.workspace_id);
      const nextTab = serverTabs.find(item => item.focused)
        || serverTabs.find(item => item.tab_id === focusedServerWorkspace?.active_tab_id)
        || serverTabs[0];
      if (previousStillPresent) return;
      if (focusedServerWorkspace) setWorkspaceId(focusedServerWorkspace.workspace_id);
      setTabId(nextTab?.tab_id || '');
      pendingFocus.current = null;
      return;
    }
    if (workspace && workspace.workspace_id !== workspaceId) setWorkspaceId(workspace.workspace_id);
    if (selectedTab && selectedTab.tab_id !== tabId) setTabId(selectedTab.tab_id);
  }, [selectedTab, snapshot.tabs, snapshot.workspaces, tabId, workspace, workspaceId]);

  // Follow server focus while hidden or before a usable local selection exists.
  // Once visible, keep the selected terminal stable while startup focus events settle.
  useEffect(() => {
    if (!followServerFocus || !serverWorkspaceId) return;
    if (!serverTabId) {
      pendingPaneFocus.current = null;
      setWorkspaceId(serverWorkspaceId);
      setTabId('');
      return;
    }
    if (!serverFocusMatchesPendingPane(serverPaneId, pendingPaneFocus.current)) return;
    setWorkspaceId(serverWorkspaceId);
    setTabId(serverTabId);
  }, [followServerFocus, serverPaneId, serverTabId, serverWorkspaceId]);

  // Preserve an explicit terminal choice until Herdr confirms the same pane.
  useEffect(() => {
    if (!visible) {
      pendingPaneFocus.current = null;
      lastActivePaneId.current = null;
      return;
    }
    const activeSession = terminalState.sessions.find(item => item.terminalId === terminalState.activeTerminalId);
    const activeSessionPane = snapshot.panes.find(item => item.pane_id === activeSession?.paneId);
    if (!activeSessionPane || activeSessionPane.pane_id === lastActivePaneId.current) return;
    lastActivePaneId.current = activeSessionPane.pane_id;
    pendingPaneFocus.current = activeSessionPane.pane_id;
    setWorkspaceId(activeSessionPane.workspace_id);
    setTabId(activeSessionPane.tab_id);
  }, [snapshot.panes, terminalState.activeTerminalId, terminalState.sessions, visible]);

  const activateServerPane = useEffectEvent((paneId: string) => {
    const pane = snapshot.panes.find(item => item.pane_id === paneId);
    if (pane) onActivateTerminal(pane);
  });

  // Keep a hidden or uninitialized terminal aligned with the server-focused pane.
  useEffect(() => {
    if (!followServerFocus || !serverPaneId) return;
    if (!serverFocusMatchesPendingPane(serverPaneId, pendingPaneFocus.current)) return;
    pendingPaneFocus.current = null;
    activateServerPane(serverPaneId);
  }, [followServerFocus, serverPaneId]);

  const run = async (action: () => Promise<void>, refresh = true): Promise<boolean> => {
    try {
      return await runWithInFlightGuard(mutationInFlight, async () => {
        setBusy(true);
        try {
          await action();
          if (refresh) await onRefresh();
        } finally {
          setBusy(false);
        }
      });
    } catch (error) {
      showHerdrError(error);
      return false;
    }
  };

  const chooseTab = (item: TabInfo) => {
    const nextPanes = snapshot.panes.filter(pane => pane.tab_id === item.tab_id);
    const nextPane = nextPanes.find(pane => pane.focused) || nextPanes[0];
    if (nextPane) terminalTabSelectionStarted(nextPane.terminal_id);
    setWorkspaceId(item.workspace_id);
    setTabId(item.tab_id);
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

  const handleVolumeKey = useEffectEvent((key: TerminalVolumeKey) => {
    if (!visible) return;
    const configured = key === 'up'
      ? terminalPreferences.volumeUpAction
      : terminalPreferences.volumeDownAction;
    const action = resolveTerminalVolumeKeyAction(configured, key);
    if (action?.type !== 'terminal-tab') return;
    const context = swipeContextRef.current;
    const currentIndex = context.tabs.findIndex(item => item.tab_id === context.selectedTab?.tab_id);
    const targetIndex = neighborTabIndex(currentIndex, context.tabs.length, action.direction);
    if (targetIndex !== null) chooseTabRef.current(context.tabs[targetIndex]);
  });

  useEffect(() => {
    const subscription = addTerminalVolumeKeyListener(handleVolumeKey);
    return () => subscription.remove();
  }, []);

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

  const finishTabSwipe = (originTabId: string, targetTabId: string, commit: boolean) => {
    const swipe = tabSwipeRef.current;
    if (!swipe || swipe.originTabId !== originTabId || swipe.targetTabId !== targetTabId) return;
    if (commit) {
      const target = swipeContextRef.current.tabs.find(item => item.tab_id === targetTabId);
      if (target) chooseTabRef.current(target);
    }
    tabSwipeRef.current = null;
    setTabSwipe(null);
    tabSwipeTranslateX.value = 0;
  };

  const settleTabSwipe = (commit: boolean) => {
    const swipe = tabSwipeRef.current;
    if (!swipe) return;
    const destination = commit ? -swipe.direction * terminalWidthRef.current : 0;
    tabSwipeTranslateX.value = withSpring(destination, {
      ...DEFAULT_SPRING_CONFIG,
      stiffness: 240,
    }, finished => {
      if (finished) {
        scheduleOnRN(finishTabSwipe, swipe.originTabId, swipe.targetTabId, commit);
      }
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
      tabSwipeTranslateX.value = terminalTabSwipeOffset(
        gesture.dx,
        terminalWidthRef.current,
        swipe.direction,
      );
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
    cancelAnimation(tabSwipeTranslateX);
    tabSwipeTranslateX.value = 0;
  }, [tabSwipeTranslateX, visible]);

  const choosePane = (pane: PaneInfo) => {
    terminalTabSelectionStarted(pane.terminal_id);
    onActivateTerminal(pane);
    run(() => client.focusPane(pane.pane_id));
  };

  const create = async () => {
    if (mutationInFlight.current) return;
    let succeeded = true;
    if (editorMode === 'rename-tab' && selectedTab) {
      succeeded = await run(() => client.renameTab(selectedTab.tab_id, name));
    } else if (editorMode === 'rename-pane' && editingPaneId) {
      succeeded = await run(() => client.renamePane(editingPaneId, name));
    } else if (workspace) {
      // Creating a focused tab intentionally replaces the current pane choice.
      // Do not let the old pane's pending-focus guard reject the new server pane.
      pendingPaneFocus.current = null;
      pendingFocus.current = null;
      succeeded = await run(async () => {
        const created = await client.createTab(workspace.workspace_id, name);
        activateCreatedTabLocally(created, {
          select: (workspaceId, createdTabId) => {
            setWorkspaceId(workspaceId);
            setTabId(createdTabId);
          },
          terminalSelectionStarted: terminalTabSelectionStarted,
          activateTerminal: onActivateTerminal,
        });
      }, false);
    }
    if (!succeeded) pendingFocus.current = null;
    setName('');
    setEditingPaneId(null);
    setEditorMode(null);
  };

  const openRenameTab = (item: TabInfo | undefined = selectedTab) => {
    if (!item) return;
    if (item.tab_id !== selectedTab?.tab_id) chooseTab(item);
    setName(item.label);
    setEditingPaneId(null);
    setEditorMode('rename-tab');
  };

  const closeTab = async (item: TabInfo | undefined = selectedTab) => {
    if (!item) return;
    // Herdr focuses a surviving tab after closing the current one.
    pendingPaneFocus.current = null;
    pendingFocus.current = { previousId: item.tab_id };
    if (!await run(() => client.closeTab(item.tab_id))) pendingFocus.current = null;
  };

  const openRenamePane = (pane: PaneInfo) => {
    if (pane.pane_id !== selectedPane?.pane_id) choosePane(pane);
    setName(pane.label || '');
    setEditingPaneId(pane.pane_id);
    setEditorMode('rename-pane');
  };

  const closePane = async (pane: PaneInfo) => {
    if (editingPaneId === pane.pane_id) {
      setEditingPaneId(null);
      setEditorMode(null);
    }
    await run(() => client.closePane(pane.pane_id));
  };

  const closeEditor = () => {
    setName('');
    setEditingPaneId(null);
    setEditorMode(null);
  };

  const openFileManager = () => {
    if (activeTerminalSession) onOpenFiles(activeTerminalSession.terminalId);
  };

  const openChatFile = (target: TranscriptFileLinkTarget) => {
    if (!activeTerminalSession || !activePane) return;
    const activeWorkspace = snapshot.workspaces.find(item => item.workspace_id === activePane.workspace_id);
    const directory = activeChatView?.state.transcript.info?.directory
      || activePane.foreground_cwd
      || activePane.cwd
      || activeWorkspace?.worktree?.checkout_path;
    onOpenFiles(activeTerminalSession.terminalId, {
      ...target,
      path: resolveTranscriptFilePath(target.path, directory || undefined),
    });
  };

  const openAttachments = () => {
    if (!activeTerminalSession || activeTerminalSession.status !== 'connected') return;
    setAttachmentTerminalId(activeTerminalSession.terminalId);
    setAttachmentsOpen(true);
  };

  const closeActiveChat = useCallback(() => {
    const terminalId = activeTerminalSession?.terminalId;
    if (!terminalId) return;
    setChatViews(current => {
      if (!current.has(terminalId)) return current;
      const next = new Map(current);
      next.delete(terminalId);
      return next;
    });
  }, [activeTerminalSession?.terminalId]);

  const promptCodexIntegrationInstall = (
    paneId: string,
    status: Extract<CodexIntegrationStatus, 'not-installed' | 'outdated' | 'needs-repair'>,
  ) => {
    setCodexIntegrationPrompt({ paneId, status });
  };

  const installCodexIntegration = async () => {
    if (!codexIntegrationPrompt || codexIntegrationInstallingRef.current) return;
    const { paneId } = codexIntegrationPrompt;
    const request = codexIntegrationInstallRequestRef.current + 1;
    codexIntegrationInstallRequestRef.current = request;
    codexIntegrationInstallingRef.current = true;
    setCodexIntegrationPrompt(null);
    setCodexIntegrationInstalling(true);
    try {
      await client.installCodexIntegration();
      if (request !== codexIntegrationInstallRequestRef.current) return;
      await onRefresh();
      if (request !== codexIntegrationInstallRequestRef.current) return;
      setPendingIntegrationPaneId(paneId);
    } catch (error) {
      if (request === codexIntegrationInstallRequestRef.current) {
        showAppAlert('Could not install Codex integration', error);
      }
    } finally {
      if (request === codexIntegrationInstallRequestRef.current) {
        codexIntegrationInstallingRef.current = false;
        setCodexIntegrationInstalling(false);
      }
    }
  };

  const openAgentChat = async () => {
    if (!activePane || !activeTerminalSession) return;
    const agent = chatAgentForPane(activePane);
    if (agent === 'opencode') {
      const sessionId = openCodeSessionIdForPane(activePane);
      if (!sessionId) {
        setAgentIdentityWarning({
          agent: 'opencode',
          title: 'OpenCode identity unavailable',
          message: 'This OpenCode process has not reported a native session ID. Ensure the Herdr OpenCode integration is current, then restart OpenCode and try Chat again.',
        });
        return;
      }
      const key = openCodeTranscriptService.activate(hostSessionId, activeTerminalSession.terminalId, sessionId, client);
      setChatViews(current => {
        const next = new Map(current);
        next.set(activeTerminalSession.terminalId, {
          agent: 'opencode',
          key,
          state: openCodeTranscriptService.getState(key) || loadingChatState(sessionId),
        });
        return next;
      });
      return;
    }
    if (agent !== 'codex') return;
    const action = codexChatAction(activePane);
    if (action === 'open') {
      const sessionId = codexSessionIdForPane(activePane)!;
      const key = codexTranscriptService.activate(hostSessionId, activeTerminalSession.terminalId, sessionId, client);
      if (!codexTranscriptService.hasCachedHistory(key)) {
        setCodexHistoryWarmup({ key, sessionId, terminalId: activeTerminalSession.terminalId });
        return;
      }
      setChatViews(current => {
        const next = new Map(current);
        next.set(activeTerminalSession.terminalId, {
          agent: 'codex',
          key,
          state: codexTranscriptService.getState(key) || loadingChatState(sessionId),
        });
        return next;
      });
      return;
    }
    if (action !== 'setup') return;
    const paneId = activePane.pane_id;
    setBusy(true);
    try {
      const integrationStatus = await client.codexIntegrationStatus();
      const missingIdentityAction = codexMissingIdentityAction(integrationStatus);
      if (missingIdentityAction === 'diagnose') {
        setAgentIdentityWarning({
          agent: 'codex',
          title: 'Codex identity unavailable',
          message: 'The Herdr Codex integration is installed, but this process did not report a native session ID. If Codex was started after the integration was installed, restarting again will not help. Check the Herdr Codex hook and its host dependencies, then tap Chat again.',
        });
      } else if (missingIdentityAction === 'unknown') {
        setAgentIdentityWarning({
          agent: 'codex',
          title: 'Could not verify Codex integration',
          message: 'Whip could not read the Codex row from `herdr integration status`. No changes were made on the remote host.',
        });
      } else if (
        integrationStatus === 'not-installed'
        || integrationStatus === 'outdated'
        || integrationStatus === 'needs-repair'
      ) {
        promptCodexIntegrationInstall(paneId, integrationStatus);
      }
    } catch (error) {
      showAppAlert('Could not check Codex integration', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible ? 'auto' : 'none'}
      style={!visible && terminalPreferences.fullscreen && safeAreaInsets.top > 0
        ? { bottom: -safeAreaInsets.top }
        : undefined}
      className={cn('flex-1 bg-terminal-canvas', !visible && 'absolute inset-0')}>
      <TerminalBackground preferences={terminalPreferences} />
      <View className="absolute inset-x-0 top-0 z-30">
        <View className="h-[55px] flex-row border-b border-border bg-transparent">
          <Button
            accessibilityLabel={t('session.backToHerd')}
            className={cn('h-[55px] items-center justify-center rounded-none px-0 py-0', Platform.OS === 'ios' ? 'w-14' : 'w-[42px]')}
            size="content"
            variant="ghost"
            onPress={hapticPress(onExit)}>
            <ChevronLeft size={Platform.OS === 'ios' ? 23 : 21} color={colors.text} />
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
                  <View
                    key={item.tab_id}
                    className={cn('h-[39px] max-w-[170px] flex-row items-center overflow-hidden rounded-full border', isIpad && 'h-[45px] max-w-[230px]')}
                    style={sessionTabGlassStyle(active, colors)}>
                    <Button accessibilityLabel={t('session.openTab', { tab: label })} className={cn('h-[39px] min-w-0 flex-shrink justify-start gap-2 rounded-none px-[11px] py-0 pr-1 active:bg-transparent active:opacity-70 dark:active:bg-transparent', isIpad && 'h-[45px] px-3')} variant="ghost" onPress={hapticPress(() => chooseTab(item))} onLongPress={hapticPress(() => openRenameTab(item))}>
                      <AnimatedAgentStatusGlyph status={item.agent_status} color={sessionTabStatusColor(item.agent_status, itemSession?.status, colors)} size={isIpad ? 16 : 12} />
                      <Text numberOfLines={1} className={cn('max-w-[94px] pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', isIpad && 'max-w-[140px] text-[14px] leading-5', active && 'text-primary-foreground')}>{label}</Text>
                      {item.pane_count > 1 && <Text className={cn('font-mono text-[8px] text-muted-foreground', isIpad && 'text-[11px]', active && 'text-primary-foreground')}>{item.pane_count}</Text>}
                    </Button>
                    <Button accessibilityLabel={t('session.closeTab', { tab: label })} className={cn('h-[39px] w-7 rounded-none px-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent', isIpad && 'h-[45px] w-8')} variant="ghost" onPress={hapticPress(() => closeTab(item))}>
                      <X size={isIpad ? 18 : 14} color={active ? colors.onPrimary : colors.textSecondary} />
                    </Button>
                  </View>
                );
              })}
            </ScrollView>
            <Button
              accessibilityLabel={t('session.newTab')}
              className={cn('h-[55px] items-center justify-center rounded-none px-0 py-0', Platform.OS === 'ios' ? 'w-14' : 'w-11')}
              disabled={busy}
              size="content"
              variant="ghost"
              onPress={hapticPress(() => setEditorMode('tab'))}>
              <Plus size={Platform.OS === 'ios' ? 23 : 16} color={colors.text} />
            </Button>
          </>
        ) : activeTerminalSession?.kind === 'ssh' ? (
          <>
            <Text className="flex-1 self-center px-2 font-mono text-[11px] font-semibold text-foreground">
              {t('terminal.sshShell')}
            </Text>
            <Button
              accessibilityLabel={t('terminal.closeSession')}
              className="h-[55px] w-11 rounded-none px-0"
              variant="ghost"
              onPress={hapticPress(() => onCloseTerminal(activeTerminalSession.terminalId))}>
              <X size={17} color={colors.text} />
            </Button>
          </>
          ) : null}
        </View>

        <ResourceEditorSheet
          busy={busy}
          context={editorContext}
          icon={SquareTerminal}
          onClose={closeEditor}
          onSave={create}
          title={editorTitle}
          visible={editorMode !== null}>
          <ResourceEditorField
            label={editorMode === 'rename-pane' ? t('pane.label') : t('herd.tabName')}>
            <Input
              accessibilityLabel={editorMode === 'rename-pane' ? t('pane.label') : t('herd.tabName')}
              autoFocus
              autoCorrect={false}
              editable={!busy}
              returnKeyType="done"
              selectTextOnFocus={editorMode?.startsWith('rename')}
              value={name}
              onChangeText={setName}
              onSubmitEditing={() => { create(); }}
              placeholder={editorMode === 'tab'
                ? t('herd.tabNamePlaceholder')
                : t('herd.labelOptional')}
              placeholderTextColor={colors.textTertiary}
            />
          </ResourceEditorField>
        </ResourceEditorSheet>

        {selectedTab && panes.length > 1 && (
          <View className="h-[37px] flex-row border-b border-border bg-transparent">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center px-1.5 gap-[5px]">
              {panes.map(pane => {
                const active = pane.terminal_id === selectedPane?.terminal_id;
                const label = pane.label || pane.display_agent || pane.agent || 'shell';
                return (
                  <View
                    key={pane.pane_id}
                    className="h-7 max-w-[174px] flex-row items-center overflow-hidden rounded-full border"
                    style={sessionTabGlassStyle(active, colors)}>
                    <Button accessibilityLabel={t('session.openPane', { pane: label })} className="h-7 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2 py-0" variant="ghost" onPress={hapticPress(() => choosePane(pane))} onLongPress={hapticPress(() => openRenamePane(pane))}>
                      <View className="size-[5px] rounded-full" style={{ backgroundColor: statusColor(pane.agent_status, colors) }} />
                      <Text numberOfLines={1} className={cn('max-w-[112px] pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', active && 'text-primary-foreground')}>{label}</Text>
                    </Button>
                    <Button accessibilityLabel={t('session.closePane', { pane: label })} className="h-7 w-7 rounded-none px-0" disabled={busy} variant="ghost" onPress={hapticPress(() => closePane(pane))}>
                      <X size={13} color={active ? colors.onPrimary : colors.textSecondary} />
                    </Button>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        )}
      </View>

      <View
        className="relative flex-1 overflow-hidden bg-transparent"
        onTouchStart={() => registerInteraction()}
        onLayout={event => {
          terminalWidthRef.current = event.nativeEvent.layout.width;
          setTerminalWidth(event.nativeEvent.layout.width);
        }}>
        <Animated.View
          pointerEvents="box-none"
          style={[
            StyleSheet.absoluteFill,
            activeTerminalSwipeStyle,
          ]}>
          <TerminalScreen
            activeTarget={activeTarget}
            previewTarget={previewTarget}
            targets={terminalTargets}
            compact
            topOverlayInset={topOverlayInset}
            latencyMs={latencyMs}
            latencyWarningActive={latencyWarningActive}
            visible={visible && Boolean(activeTarget)}
            swipe={tabSwipe && previewTarget
              ? { direction: tabSwipe.direction, offset: tabSwipeTranslateX }
              : null}
            terminalPanHandlers={terminalTabPanResponder.panHandlers}
            preferences={terminalPreferences}
            controlUsage={terminalControlUsage}
            historyEntries={terminalHistory}
            getComposerDraft={getComposerDraft}
            onComposerDraftChange={onComposerDraftChange}
            linkScanRequest={linkScanRequest}
            pasteRequest={pasteRequest && pasteRequest.terminalId === activeTerminalSession?.terminalId
              ? {
                  id: pasteRequest.id,
                  text: pasteRequest.text,
                  previewUri: pasteRequest.previewUri,
                  dispose: pasteRequest.dispose,
                }
              : undefined}
            onRequestAttachment={openAttachments}
            onRequestFiles={openFileManager}
            onRequestLinks={scanTerminalLinks}
            chatControl={activeChatAgent ? {
              accessibilityLabel: codexChatLoading
                ? codexIntegrationInstalling
                  ? 'Installing Codex integration'
                  : 'Loading Codex history'
                : chatVisible
                  ? 'Open Terminal view'
                  : `Open ${activeChatAgent === 'opencode' ? 'OpenCode' : 'Codex'} Chat view`,
              active: chatVisible,
              disabled: busy || codexChatLoading,
              loading: codexChatLoading,
              onPress: hapticPress(chatVisible ? closeActiveChat : openAgentChat),
            } : undefined}
            viewportOverlay={activeChatView && activePane ? (
              <AgentChatView
                state={activeChatView.state}
                agent={activeChatView.agent}
                agentStatus={activePane.agent_status}
                onOpenFile={openChatFile}
              />
            ) : undefined}
            viewportOverlayBackground={chatVisible && appGlassEnabled ? (
              <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
            ) : undefined}
            onOpenLink={link => {
              if (terminalPreferences.openLinksInApp) setLinksOpen(true);
              openTerminalLink(link);
            }}
            onLinksScanned={links => {
              setTerminalLinks(links);
              setLinksBusy(false);
            }}
            onControlUse={onTerminalControlUse}
            onHistoryEntry={onTerminalHistoryEntry}
            onInteraction={registerInteraction}
            onFontSizeChange={(target, fontSize) => {
              onTerminalFontSizeChange(target.hostSessionId, target.session.terminalId, fontSize);
            }}
            onClose={() => {
              if (activeTerminalSession) onCloseTerminal(activeTerminalSession.terminalId);
            }}
            onStatus={(target, status, error, reconnectAttempt) => {
              onTerminalStatus(
                target.hostSessionId,
                target.session.terminalId,
                status,
                error,
                reconnectAttempt,
              );
            }}
          />
        </Animated.View>
        {tabSwipe
          && (!tabSwipe.targetTerminalId
            || !terminalState.sessions.some(session => session.terminalId === tabSwipe.targetTerminalId))
          && (
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                previewPlaceholderStyle,
              ]}
              className="items-center justify-center bg-terminal-canvas p-[30px]">
              <Text className="text-[10px] font-black text-terminal-text">{tabSwipe.targetLabel}</Text>
            </Animated.View>
          )}
        {!activeTarget && !snapshot.server.running && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-black text-terminal-text">{t('session.serverUnavailable')}</Text>
            <Text className="mt-2 text-center text-terminal-muted">{t('session.serverUnavailableCopy')}</Text>
            <Button className="mt-5 rounded-full px-5" variant="secondary" onPress={hapticPress(onExit)}>
              <Text>{t('session.backToHerd')}</Text>
            </Button>
          </View>
        )}
        {!activeTarget && snapshot.server.running && !selectedTab && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-black text-terminal-text">{workspace ? t('session.emptyWorkspace') : t('session.noWorkspaces')}</Text>
            <Text className="mt-2 text-center text-terminal-muted">{workspace ? t('session.createTab') : t('session.createWorkspace')}</Text>
          </View>
        )}
        {!activeTarget && snapshot.server.running && selectedTab && panes.length === 0 && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-black text-terminal-text">{t('session.emptyTab')}</Text>
            <Text className="mt-2 text-center text-terminal-muted">{t('session.emptyTabCopy')}</Text>
          </View>
        )}
        <AttachmentPasteSheet
          client={client}
          visible={attachmentsOpen}
          onClose={() => setAttachmentsOpen(false)}
          onPaste={(attachment: PastedAttachment) => {
            if (!attachmentTerminalId) {
              attachment.dispose();
              return;
            }
            setPasteRequest(current => ({
              id: (current?.id || 0) + 1,
              terminalId: attachmentTerminalId,
              text: attachment.remotePath,
              previewUri: attachment.previewUri,
              dispose: attachment.dispose,
            }));
          }}
        />
        <CodexIntegrationInstallSheet
          status={codexIntegrationPrompt?.status || null}
          onCancel={() => setCodexIntegrationPrompt(null)}
          onInstall={installCodexIntegration}
        />
        <AgentIdentityWarningSheet
          warning={agentIdentityWarning}
          onClose={() => setAgentIdentityWarning(null)}
        />
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
                    <Text className="text-[8px] uppercase tracking-[1px] text-muted-foreground">{t('terminal.linksLatestFirst')}</Text>
                  </View>
                  <Button accessibilityLabel={t('terminal.closeLinks')} className="size-11 rounded-full px-0" variant="ghost" onPress={dismissLinks}>
                    <X size={19} color={colors.text} />
                  </Button>
                </View>
                <View className="min-h-[66px] flex-row items-center border-b border-border px-4 py-3">
                  <View className="min-w-0 flex-1 pr-4">
                    <Text className="text-[14px] font-semibold text-foreground">{t('terminal.openLinksInApp')}</Text>
                    <Text className="mt-0.5 text-[10px] leading-[14px] text-muted-foreground">{t('terminal.openLinksInAppCopy')}</Text>
                  </View>
                  <Switch
                    accessibilityLabel={t('terminal.openLinksInApp')}
                    checked={terminalPreferences.openLinksInApp}
                    onCheckedChange={onTerminalOpenLinksInAppChange}
                  />
                </View>
                {linksBusy ? (
                  <View className="flex-1 items-center justify-center gap-3 p-8">
                    <ActivityIndicator color={colors.primary} />
                    <Text className="text-[12px] text-muted-foreground">{t('terminal.scanningLinks')}</Text>
                  </View>
                ) : linksError ? (
                  <View className="flex-1 items-center justify-center p-8">
                    <Text className="text-center text-[13px] font-semibold text-destructive">{t('terminal.linkOpenFailed')}</Text>
                    <Text className="mt-2 text-center text-[9px] text-muted-foreground">{linksError}</Text>
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
      <AppAlertPopup
        message={appAlert?.message}
        title={appAlert?.title || ''}
        visible={appAlert !== null}
        onClose={() => setAppAlert(null)}
      />
    </View>
  );
}
