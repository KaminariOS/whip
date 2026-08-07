import './global.css';

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BlurTargetView } from 'expo-blur';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { useKeepAwake } from 'expo-keep-awake';
import { useLocales } from 'expo-localization';
import { PortalHost } from '@rn-primitives/portal';
import { Alert, Appearance, AppState, BackHandler, Platform, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { BottomNavigation } from './src/components/BottomNavigation';
import { AppBackground } from './src/components/AppBackground';
import { AppAccessLock } from './src/components/AppAccessLock';
import { ConnectionScreen } from './src/components/ConnectionScreen';
import { ConnectRequiredScreen } from './src/components/ConnectRequiredScreen';
import { HerdScreen } from './src/components/HerdScreen';
import { GlobalKeychainScreen } from './src/components/GlobalKeychainScreen';
import { GlassProvider } from './src/components/GlassSurface';
import { HostsScreen } from './src/components/HostsScreen';
import { KnownHostsScreen } from './src/components/KnownHostsScreen';
import type { LiveSessionRailItem } from './src/components/LiveSessionRail';
import { MoreScreen } from './src/components/MoreScreen';
import { PaneDetail } from './src/components/PaneDetail';
import { SessionScreen } from './src/components/SessionScreen';
import { ReducedMotionProvider, WhipMark } from './src/components/app-ui';
import type { HerdHostQueue } from './src/herdQueue';
import { emptyConnectionProfile, hostDisplayName, resolveJumpHostChain } from './src/lib/hostProfiles';
import {
  classifyConnectionError,
  connectionErrorContext,
  connectionErrorTranslationKeys,
} from './src/lib/connectionErrors';
import { resolveColorScheme } from './src/lib/appearance';
import { biometricResumeAction } from './src/lib/appAccess';
import { requiresBiometricForKeyUse, requiresBiometricForSavedKey } from './src/lib/biometricSecurity';
import {
  activeTabUsesBriefAlerts,
  agentFromStatusEvent,
  tabNameForAgent,
  agentStatusFromEvent,
  shouldNotifyAgentTransition,
} from './src/lib/agentStatusEvents';
import { isHerdrProtocolMismatch } from './src/lib/herdrProtocol';
import { shouldRefreshLiveHost } from './src/lib/liveHostHeartbeat';
import { nextReconnect } from './src/lib/reconnectPolicy';
import {
  incrementTerminalControlUsage,
  type TerminalControlId,
  type TerminalControlUsage,
} from './src/lib/terminalControls';
import {
  addTerminalHistoryEntry,
  removeTerminalHistoryEntries,
} from './src/lib/terminalHistory';
import {
  terminalRendererKey,
  type TerminalRenderTarget,
} from './src/lib/terminalRenderer';
import type { TerminalVolumeKeyAction } from './src/lib/volumeKeys';
import {
  parseAgentNotificationTarget,
  resolveAgentNotificationTarget,
} from './src/lib/notificationNavigation';
import { createRefreshCoordinator, type RefreshCoordinator } from './src/lib/refreshCoordinator';
import {
  createEventRefreshScheduler,
  type EventRefreshScheduler,
} from './src/lib/eventRefreshScheduler';
import {
  applyLiveHostAgentStatus,
  applyLiveHostFocus,
  applyLiveHostLayoutUpdate,
  applyLiveHostPaneUpdate,
  applyLiveHostSnapshot,
  aggregateAgentStatus,
  beginLiveHostSync,
  canRefreshLiveHostSession,
  closeLiveHostSession,
  emptyLiveHostSessions,
  failLiveHostSync,
  findLiveHostSession,
  getActiveLiveHostSession,
  openLiveHostSession,
  replaceLiveHostTerminals,
  selectLiveHostSession,
  updateLiveHostConnection,
  updateLiveHostTerminals,
  type LiveHostSession,
} from './src/liveHostSessions';
import {
  handleMobileBack,
  initialMobileNavigation,
  selectMobileTab,
} from './src/mobileNavigation';
import { alertAgent, prepareAlerts } from './src/services/alerts';
import { authenticateAppAccess } from './src/services/appAuthentication';
import { startBackgroundMonitoring, stopBackgroundMonitoring } from './src/services/backgroundMonitoring';
import {
  defaultDevicePreferences,
  loadDevicePreferences,
  saveDevicePreferences,
  type AppearancePreference,
  type LanguagePreference,
  type TerminalPreferences,
} from './src/services/devicePreferences';
import { HerdrClient } from './src/services/HerdrClient';
import {
  deleteHostProfile,
  loadConnectionProfile,
  loadHostProfiles,
  loadJumpHostConnectionProfiles,
  markHostConnected,
  saveConnectionProfile,
} from './src/services/hostProfiles';
import {
  credentialRecoveryStatus,
  restoreCredentialBackups,
  type CredentialRecoveryStatus,
} from './src/services/credentialVault';
import { loadGlobalSshKeys, unlockGlobalSshKeychain } from './src/services/globalSshKeychain';
import {
  hostKeyErrorHost,
  loadKnownHosts,
  parseUnknownHostKey,
  trustKnownHost,
  type UnknownHostKeyChallenge,
} from './src/services/knownHosts';
import { loadPersistedTerminals, savePersistedTerminals } from './src/services/persistedTerminals';
import { loadTerminalHistory, saveTerminalHistory } from './src/services/terminalHistory';
import { configureTerminalVolumeKeys } from './src/services/volumeKeys';
import {
  loadPersistedLiveHosts,
  savePersistedLiveHosts,
  type PersistedLiveHosts,
} from './src/services/persistedLiveHosts';
import {
  closeTerminalSession,
  openSshShellSession,
  openTerminalSession,
  reconcileTerminalSessions,
  updateTerminalSession,
  type TerminalSessionStatus,
} from './src/terminalSessions';
import { useTheme } from './src/theme';
import type { AgentInfo, AgentStatus, AppTab, ConnectionProfile, GlobalSshKey, GlobalSshKeyMaterial, HerdrSnapshot, HostProfile, KnownHost, PaneInfo } from './src/types';
import type { HerdrApiEvent } from './src/lib/herdrApiBridge';
import { guiFontFamilies } from './src/lib/guiFonts';
import { terminalFontFamily } from './src/lib/terminalFonts';
import i18n, { languageForLocale } from './src/i18n';

const guiFontAssets = {
  [guiFontFamilies.regular]: require('./assets/gui-fonts/Inter-Regular.ttf'),
  [guiFontFamilies.medium]: require('./assets/gui-fonts/Inter-Medium.ttf'),
  [guiFontFamilies.semiBold]: require('./assets/gui-fonts/Inter-SemiBold.ttf'),
  [guiFontFamilies.bold]: require('./assets/gui-fonts/Inter-Bold.ttf'),
  [guiFontFamilies.extraBold]: require('./assets/gui-fonts/Inter-ExtraBold.ttf'),
  [guiFontFamilies.black]: require('./assets/gui-fonts/Inter-Black.ttf'),
  [terminalFontFamily]: require('./assets/terminal-fonts/JetBrainsMono-Regular.ttf'),
};

const LIVE_HOST_HEALTHCHECK_MS = 15_000;
const LIVE_HOST_RECONCILE_MS = 120_000;

interface LiveRuntime {
  client: HerdrClient;
  profile: ConnectionProfile;
  refresh: RefreshCoordinator<SnapshotMeasurement>;
  previousStatuses: Map<string, AgentStatus> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  eventPaneKey: string | null;
  eventStatus: 'closed' | 'opening' | 'open';
  eventReconnectAttempts: number;
  eventReconnectTimer: ReturnType<typeof setTimeout> | null;
  eventRefresh: EventRefreshScheduler;
}

interface SnapshotMeasurement {
  snapshot: HerdrSnapshot;
  latencyMs: number | null;
}

interface ConnectOptions {
  persistProfile?: boolean;
  navigate?: boolean;
  markUsed?: boolean;
  trackConnecting?: boolean;
  activateSession?: boolean;
  biometricVerified?: boolean;
  promptForUnknownHosts?: boolean;
}

let retainedBackgroundRuntimes: Map<string, LiveRuntime> | null = null;

function disposeRuntimes(target: Map<string, LiveRuntime>): void {
  for (const runtime of target.values()) {
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    if (runtime.eventReconnectTimer) clearTimeout(runtime.eventReconnectTimer);
    runtime.eventRefresh.cancel();
    runtime.refresh.invalidate();
    runtime.client.releaseAllTerminals()
      .finally(() => runtime.client.disconnect());
  }
  target.clear();
}

function App() {
  const [guiFontsLoaded, guiFontError] = useFonts(guiFontAssets);
  if (!guiFontsLoaded && !guiFontError) return null;

  return (
    <SafeAreaProvider>
      <ReducedMotionProvider>
        <AppContent />
        <PortalHost />
      </ReducedMotionProvider>
    </SafeAreaProvider>
  );
}

const NavigationBlurTarget = Platform.OS === 'android' ? View : BlurTargetView;

function AppContent() {
  const { t } = useTranslation();
  const { colors: theme, isDark } = useTheme();
  const locales = useLocales();
  const runtimes = useRef(new Map<string, LiveRuntime>());
  const liveSessionsRef = useRef(emptyLiveHostSessions);
  const navigationBlurTargetRef = useRef<View | null>(null);
  const hostsRef = useRef<HostProfile[]>([]);
  const knownHostsRef = useRef<KnownHost[]>([]);
  const persistedLiveHostsRef = useRef<PersistedLiveHosts>({ hostIds: [], activeHostId: null });
  const restoredTerminalHostIdsRef = useRef(new Set<string>());
  const restoreStarted = useRef(false);
  const alertsEnabledRef = useRef(true);
  const persistentAlertDurationSecondsRef = useRef(defaultDevicePreferences.persistentAlertDurationSeconds);
  const ttsEnabledRef = useRef(false);
  const handledNotificationIdRef = useRef<string | null>(null);
  const biometricOnResumeRef = useRef(defaultDevicePreferences.biometricOnResume);
  const biometricForKeysRef = useRef(defaultDevicePreferences.biometricForKeys);
  const preferencesLoadedRef = useRef(false);
  const appAuthenticationInFlightRef = useRef(false);
  const securitySettingChangeInFlightRef = useRef(false);
  const [notificationResponse, setNotificationResponse] = useState<Notifications.NotificationResponse | null>(null);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [editorProfile, setEditorProfile] = useState<ConnectionProfile | null>(null);
  const [globalSshKeys, setGlobalSshKeys] = useState<GlobalSshKey[]>([]);
  const [unlockedGlobalKeys, setUnlockedGlobalKeys] = useState<GlobalSshKeyMaterial[] | null>(null);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [knownHostsOpen, setKnownHostsOpen] = useState(false);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [knownHostsLoaded, setKnownHostsLoaded] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [liveHostsLoaded, setLiveHostsLoaded] = useState(false);
  const [terminalHistoryLoaded, setTerminalHistoryLoaded] = useState(false);
  const [liveHostRestoreComplete, setLiveHostRestoreComplete] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [liveSessions, setLiveSessions] = useState(emptyLiveHostSessions);
  const [navigation, setNavigation] = useState(initialMobileNavigation);
  const [herdHostFilterId, setHerdHostFilterId] = useState<string | null>(null);
  const [herdWorkspaceFilterIds, setHerdWorkspaceFilterIds] = useState<Record<string, string | null>>({});
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [persistentAlertDurationSeconds, setPersistentAlertDurationSeconds] = useState(defaultDevicePreferences.persistentAlertDurationSeconds);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [biometricForKeys, setBiometricForKeys] = useState(defaultDevicePreferences.biometricForKeys);
  const [biometricOnResume, setBiometricOnResume] = useState(defaultDevicePreferences.biometricOnResume);
  const [appAccessLocked, setAppAccessLocked] = useState(false);
  const [appAccessAuthenticating, setAppAccessAuthenticating] = useState(false);
  const [appearance, setAppearance] = useState<AppearancePreference>(defaultDevicePreferences.appearance);
  const [fullscreenApp, setFullscreenApp] = useState(defaultDevicePreferences.fullscreenApp);
  const [appBackgroundImageUri, setAppBackgroundImageUri] = useState(defaultDevicePreferences.appBackgroundImageUri);
  const [appBackgroundDimming, setAppBackgroundDimming] = useState(defaultDevicePreferences.appBackgroundDimming);
  const [appGlassEnabled, setAppGlassEnabled] = useState(defaultDevicePreferences.appGlassEnabled);
  const [language, setLanguage] = useState<LanguagePreference>(defaultDevicePreferences.language);
  const [keepScreenOn, setKeepScreenOn] = useState(defaultDevicePreferences.keepScreenOn);
  const [reopenTerminalOnLaunch, setReopenTerminalOnLaunch] = useState(defaultDevicePreferences.reopenTerminalOnLaunch);
  const [agentCommand, setAgentCommand] = useState(defaultDevicePreferences.agentCommand);
  const [terminalPreferences, setTerminalPreferences] = useState<TerminalPreferences>(defaultDevicePreferences.terminal);
  const [terminalControlUsage, setTerminalControlUsage] = useState<TerminalControlUsage>(defaultDevicePreferences.terminalControlUsage);
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [credentialRecovery, setCredentialRecovery] = useState<CredentialRecoveryStatus>({ state: 'none', count: 0 });
  const [credentialRecoveryBusy, setCredentialRecoveryBusy] = useState(false);
  const applyAppearance = useEffectEvent((value: AppearancePreference) => {
    Appearance.setColorScheme(resolveColorScheme(value));
  });
  const resolvedLanguage = language === 'system' ? languageForLocale(locales[0]) : language;

  useEffect(() => {
    i18n.changeLanguage(resolvedLanguage).catch(() => undefined);
  }, [resolvedLanguage]);

  const updateTerminalOpenLinksInApp = useCallback((openLinksInApp: boolean) => {
    setTerminalPreferences(current => (
      current.openLinksInApp === openLinksInApp
        ? current
        : { ...current, openLinksInApp }
    ));
  }, []);

  const recordTerminalControlUse = useCallback((control: TerminalControlId) => {
    setTerminalControlUsage(current => incrementTerminalControlUsage(current, control));
  }, []);

  const recordTerminalHistoryEntry = useCallback((entry: string) => {
    setTerminalHistory(current => addTerminalHistoryEntry(current, entry));
  }, []);

  const deleteTerminalHistoryEntries = useCallback((entries: readonly string[]) => {
    setTerminalHistory(current => removeTerminalHistoryEntries(current, entries));
  }, []);

  liveSessionsRef.current = liveSessions;
  hostsRef.current = hosts;
  knownHostsRef.current = knownHosts;
  alertsEnabledRef.current = alertsEnabled;
  persistentAlertDurationSecondsRef.current = persistentAlertDurationSeconds;
  ttsEnabledRef.current = ttsEnabled;

  useEffect(() => {
    const retained = retainedBackgroundRuntimes;
    if (!retained) return;
    retainedBackgroundRuntimes = null;
    disposeRuntimes(retained);
  }, []);

  useEffect(() => {
    let active = true;
    let receivedResponse = false;
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      receivedResponse = true;
      setNotificationResponse(response);
    });
    Notifications.getLastNotificationResponseAsync()
      .then(response => {
        if (active && !receivedResponse && response) setNotificationResponse(response);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    loadHostProfiles()
      .then(async value => {
        setHosts(value);
        setCredentialRecovery(await credentialRecoveryStatus());
      })
      .catch(error => setConnectError(t('app.loadHostsError', { error: String(error) })))
      .finally(() => setProfilesLoaded(true));
    loadGlobalSshKeys().then(setGlobalSshKeys).catch(() => undefined);
    loadKnownHosts()
      .then(setKnownHosts)
      .catch(() => undefined)
      .finally(() => setKnownHostsLoaded(true));
    prepareAlerts().catch(() => undefined);
    loadDevicePreferences()
      .then(preferences => {
        setAlertsEnabled(preferences.alertsEnabled);
        setPersistentAlertDurationSeconds(preferences.persistentAlertDurationSeconds);
        setTtsEnabled(preferences.ttsEnabled);
        biometricForKeysRef.current = preferences.biometricForKeys;
        setBiometricForKeys(preferences.biometricForKeys);
        biometricOnResumeRef.current = preferences.biometricOnResume;
        setBiometricOnResume(preferences.biometricOnResume);
        setAppearance(preferences.appearance);
        setFullscreenApp(preferences.fullscreenApp);
        setAppBackgroundImageUri(preferences.appBackgroundImageUri);
        setAppBackgroundDimming(preferences.appBackgroundDimming);
        setAppGlassEnabled(preferences.appGlassEnabled);
        setLanguage(preferences.language);
        setKeepScreenOn(preferences.keepScreenOn);
        setReopenTerminalOnLaunch(preferences.reopenTerminalOnLaunch);
        setAgentCommand(preferences.agentCommand);
        applyAppearance(preferences.appearance);
        setTerminalPreferences(preferences.terminal);
        setTerminalControlUsage(preferences.terminalControlUsage);
        setNavigation(current => selectMobileTab(
          current,
          preferences.lastTab === 'terminal' ? 'hosts' : preferences.lastTab,
        ));
      })
      .finally(() => {
        preferencesLoadedRef.current = true;
        setPreferencesLoaded(true);
      });
    loadPersistedLiveHosts()
      .then(value => {
        persistedLiveHostsRef.current = value;
      })
      .finally(() => setLiveHostsLoaded(true));
    loadTerminalHistory()
      .then(setTerminalHistory)
      .catch(() => undefined)
      .finally(() => setTerminalHistoryLoaded(true));
  }, [t]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    saveDevicePreferences({
      alertsEnabled,
      persistentAlertDurationSeconds,
      ttsEnabled,
      biometricForKeys,
      biometricOnResume,
      appearance,
      fullscreenApp,
      appBackgroundImageUri,
      appBackgroundDimming,
      appGlassEnabled,
      language,
      keepScreenOn,
      reopenTerminalOnLaunch,
      agentCommand,
      lastTab: navigation.tab,
      terminal: terminalPreferences,
      terminalControlUsage,
    }).catch(() => undefined);
  }, [agentCommand, alertsEnabled, appearance, appBackgroundDimming, appBackgroundImageUri, appGlassEnabled, biometricForKeys, biometricOnResume, fullscreenApp, keepScreenOn, language, navigation.tab, persistentAlertDurationSeconds, preferencesLoaded, reopenTerminalOnLaunch, terminalControlUsage, terminalPreferences, ttsEnabled]);

  useEffect(() => {
    if (!terminalHistoryLoaded) return;
    saveTerminalHistory(terminalHistory).catch(() => undefined);
  }, [terminalHistory, terminalHistoryLoaded]);

  const updateAppearance = useCallback((value: AppearancePreference) => {
    setAppearance(value);
    Appearance.setColorScheme(resolveColorScheme(value));
  }, []);

  useEffect(() => {
    for (const session of liveSessions.sessions) {
      if (session.status !== 'connecting') {
        savePersistedTerminals(session.hostId, session.terminals).catch(() => undefined);
      }
    }
  }, [liveSessions.sessions]);

  useEffect(() => {
    if (!liveHostRestoreComplete) return;
    savePersistedLiveHosts({
      hostIds: liveSessions.sessions.map(session => session.hostId),
      activeHostId: getActiveLiveHostSession(liveSessions)?.hostId || null,
    }).catch(() => undefined);
  }, [liveHostRestoreComplete, liveSessions]);

  useEffect(() => {
    if (!liveHostRestoreComplete) return;
    const hostCount = liveSessions.sessions.length;
    const operation = alertsEnabled && hostCount > 0
      ? startBackgroundMonitoring(hostCount)
      : stopBackgroundMonitoring();
    operation.catch(error => setConnectError(t('app.backgroundUnavailable', { error: String(error) })));
  }, [alertsEnabled, liveHostRestoreComplete, liveSessions.sessions.length, t]);

  useEffect(() => () => {
    if (
      Platform.OS === 'android'
      && alertsEnabledRef.current
      && liveSessionsRef.current.sessions.length > 0
    ) {
      retainedBackgroundRuntimes = runtimes.current;
      return;
    }
    disposeRuntimes(runtimes.current);
  }, []);

  const clearReconnect = (runtime: LiveRuntime) => {
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  };

  const clearEventTimers = (runtime: LiveRuntime) => {
    if (runtime.eventReconnectTimer) clearTimeout(runtime.eventReconnectTimer);
    runtime.eventReconnectTimer = null;
    runtime.eventRefresh.cancel();
  };

  const scheduleEventReconnect = (sessionId: string, cause: unknown) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime || runtime.eventReconnectTimer) return;
    const decision = nextReconnect(runtime.eventReconnectAttempts);
    if (decision.action === 'stop') {
      runtime.eventReconnectAttempts = 0;
      refreshHost(sessionId).catch(() => undefined);
      return;
    }
    runtime.eventReconnectAttempts = decision.attempt;
    runtime.eventReconnectTimer = setTimeout(async () => {
      runtime.eventReconnectTimer = null;
      const session = findLiveHostSession(liveSessionsRef.current, sessionId);
      if (!session || runtimes.current.get(sessionId) !== runtime) return;
      try {
        await ensureEventStream(sessionId, session.snapshot, true);
        // Events emitted while the stream was down cannot be replayed. Reconcile
        // immediately so closed tabs and completed agents do not remain stale.
        await refreshHost(sessionId);
      } catch (error) {
        scheduleEventReconnect(sessionId, error || cause);
      }
    }, decision.delayMs);
  };

  async function ensureEventStream(
    sessionId: string,
    snapshot: HerdrSnapshot,
    force = false,
  ): Promise<void> {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) return;
    if (!snapshot.server.running) {
      clearEventTimers(runtime);
      runtime.eventStatus = 'closed';
      runtime.eventPaneKey = null;
      runtime.client.closeEventStream();
      return;
    }
    const paneIds = snapshot.panes.map(pane => pane.pane_id).sort();
    const paneKey = paneIds.join('\n');
    if (!force && runtime.eventPaneKey === paneKey && runtime.eventStatus !== 'closed') return;

    clearEventTimers(runtime);
    runtime.client.closeEventStream();
    runtime.eventPaneKey = paneKey;
    runtime.eventStatus = 'opening';
    await runtime.client.openEventStream(
      paneIds,
      (event: HerdrApiEvent) => {
        if (runtimes.current.get(sessionId) !== runtime) return;
        const workspaceId = typeof event.data.workspace_id === 'string' ? event.data.workspace_id : undefined;
        const tabId = typeof event.data.tab_id === 'string' ? event.data.tab_id : undefined;
        const paneId = typeof event.data.pane_id === 'string' ? event.data.pane_id : undefined;
        if (event.event === 'workspace.focused' || event.event === 'tab.focused' || event.event === 'pane.focused') {
          setLiveSessions(current => applyLiveHostFocus(current, sessionId, { workspaceId, tabId, paneId }));
        }
        if (event.event === 'pane.updated') {
          const pane = event.data.pane;
          if (pane && typeof pane === 'object' && typeof (pane as PaneInfo).pane_id === 'string') {
            setLiveSessions(current => applyLiveHostPaneUpdate(
              current,
              sessionId,
              pane as PaneInfo,
            ));
          }
        }
        if (event.event === 'layout.updated') {
          const layout = event.data.layout;
          if (layout && typeof layout === 'object' && typeof (layout as { tab_id?: unknown }).tab_id === 'string') {
            setLiveSessions(current => applyLiveHostLayoutUpdate(
              current,
              sessionId,
              layout as HerdrSnapshot['layouts'][number],
            ));
          }
        }
        if (event.event === 'pane.agent_status_changed' && paneId) {
          const agentStatus = agentStatusFromEvent(event.data.agent_status);
          const session = findLiveHostSession(liveSessionsRef.current, sessionId);
          const currentAgent = session?.snapshot.agents.find(agent => agent.pane_id === paneId);
          const agent = currentAgent ? agentFromStatusEvent(currentAgent, event.data) : null;
          const previous = runtime.previousStatuses?.get(paneId);
          const useBriefAlert = agent
            ? activeTabUsesBriefAlerts(
              agent,
              session?.snapshot.tabs ?? [],
              AppState.currentState === 'active',
              liveSessionsRef.current.activeSessionId === sessionId,
            )
            : false;
          if (
            agentStatus
            && agent
            && alertsEnabledRef.current
            && shouldNotifyAgentTransition(previous, agentStatus)
          ) {
            alertAgent(agent, ttsEnabledRef.current, {
              hostId: sessionId,
              paneId,
            }, session ? tabNameForAgent(agent, session.snapshot.tabs) : undefined,
            useBriefAlert ? 'brief' : 'persistent',
            persistentAlertDurationSecondsRef.current * 1_000).catch(() => undefined);
          }
          if (agentStatus) runtime.previousStatuses?.set(paneId, agentStatus);
          setLiveSessions(current => applyLiveHostAgentStatus(current, sessionId, paneId, event.data));
        }
        runtime.eventRefresh.schedule(event.event);
      },
      reason => {
        if (runtimes.current.get(sessionId) !== runtime) return;
        runtime.eventStatus = 'closed';
        scheduleEventReconnect(sessionId, reason || t('app.eventBridgeClosed'));
      },
    );
    if (runtimes.current.get(sessionId) !== runtime) return;
    runtime.eventStatus = 'open';
    runtime.eventReconnectAttempts = 0;
  }

  const scheduleReconnect = (sessionId: string, cause: unknown) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) return;
    if (isHerdrProtocolMismatch(cause)) {
      clearReconnect(runtime);
      setLiveSessions(current => updateLiveHostConnection(current, sessionId, {
        status: 'error',
        error: String(cause),
      }));
      return;
    }
    if (runtime.reconnectTimer) return;
    const decision = nextReconnect(runtime.reconnectAttempts);
    if (decision.action === 'stop') {
      setLiveSessions(current => updateLiveHostConnection(current, sessionId, {
        status: 'error',
        error: String(cause),
        reconnectAttempt: decision.attempts,
      }));
      return;
    }

    runtime.reconnectAttempts = decision.attempt;
    setLiveSessions(current => updateLiveHostConnection(current, sessionId, {
      status: 'reconnecting',
      error: String(cause),
      reconnectAttempt: decision.attempt,
    }));
    runtime.reconnectTimer = setTimeout(async () => {
      runtime.reconnectTimer = null;
      if (runtimes.current.get(sessionId) !== runtime) return;
      runtime.refresh.invalidate();
      try {
        await runtime.client.reconnectControl(runtime.profile);
        runtime.reconnectAttempts = 0;
        setLiveSessions(current => updateLiveHostConnection(current, sessionId, { status: 'connected' }));
        await refreshHost(sessionId);
      } catch (error) {
        scheduleReconnect(sessionId, error);
      }
    }, decision.delayMs);
  };

  const createRuntime = (sessionId: string, profile: ConnectionProfile): LiveRuntime => {
    const runtime = {
      client: new HerdrClient(),
      profile,
      previousStatuses: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      eventPaneKey: null,
      eventStatus: 'closed',
      eventReconnectAttempts: 0,
      eventReconnectTimer: null,
      eventRefresh: createEventRefreshScheduler(() => {
        refreshHost(sessionId).catch(() => undefined);
      }),
    } as LiveRuntime;
    runtime.refresh = createRefreshCoordinator(
      async () => {
        setLiveSessions(current => beginLiveHostSync(current, sessionId).state);
        // Measure device-to-host network RTT separately from the much larger
        // SSH/Herdr snapshot operation so control-plane work cannot inflate it.
        const latencyMs = await runtime.client.measureLatency().catch(() => null);
        const snapshot = await runtime.client.snapshot();
        return { snapshot, latencyMs };
      },
      measurement => {
        if (runtimes.current.get(sessionId) !== runtime) return;
        const { snapshot, latencyMs } = measurement;
        const statuses = new Map(snapshot.agents.map(agent => [agent.pane_id, agent.agent_status]));
        if (alertsEnabledRef.current && runtime.previousStatuses) {
          for (const agent of snapshot.agents) {
            const previous = runtime.previousStatuses.get(agent.pane_id);
            const useBriefAlert = activeTabUsesBriefAlerts(
              agent,
              snapshot.tabs,
              AppState.currentState === 'active',
              liveSessionsRef.current.activeSessionId === sessionId,
            );
            if (shouldNotifyAgentTransition(previous, agent.agent_status)) {
              alertAgent(agent, ttsEnabledRef.current, {
                hostId: sessionId,
                paneId: agent.pane_id,
              }, tabNameForAgent(agent, snapshot.tabs),
              useBriefAlert ? 'brief' : 'persistent',
              persistentAlertDurationSecondsRef.current * 1_000).catch(() => undefined);
            }
          }
        }
        runtime.previousStatuses = statuses;
        setLiveSessions(current => {
          const session = findLiveHostSession(current, sessionId);
          if (!session) return current;
          const updated = applyLiveHostSnapshot(
            current,
            sessionId,
            session.sync.generation,
            snapshot,
            new Date().toISOString(),
            latencyMs,
          );
          if (updated === current) return current;
          return updateLiveHostTerminals(
            updated,
            sessionId,
            terminals => reconcileTerminalSessions(terminals, snapshot.panes),
          );
        });
      },
    );
    return runtime;
  };

  async function refreshHostSnapshot(sessionId: string): Promise<HerdrSnapshot | null> {
    const runtime = runtimes.current.get(sessionId);
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    if (!runtime || !canRefreshLiveHostSession(session)) return null;
    const result = await runtime.refresh.request();
    if (result.status === 'applied') {
      clearReconnect(runtime);
      runtime.reconnectAttempts = 0;
      setConnectError(null);
      setLiveSessions(current => updateLiveHostConnection(current, sessionId, { status: 'connected' }));
      try {
        await ensureEventStream(sessionId, result.value.snapshot);
      } catch (error) {
        runtime.eventStatus = 'closed';
        scheduleEventReconnect(sessionId, error);
      }
      return result.value.snapshot;
    } else if (result.status === 'failed') {
      setLiveSessions(current => {
        const currentSession = findLiveHostSession(current, sessionId);
        if (!currentSession) return current;
        return failLiveHostSync(current, sessionId, currentSession.sync.generation, String(result.error));
      });
      scheduleReconnect(sessionId, result.error);
    }
    return null;
  }

  async function refreshHost(sessionId: string): Promise<void> {
    await refreshHostSnapshot(sessionId);
  }

  const resumeLiveConnections = useEffectEvent((reconcile = false) => {
    for (const session of liveSessionsRef.current.sessions) {
      const sessionId = session.id;
      const runtime = runtimes.current.get(sessionId);
      if (
        !runtime ||
        !shouldRefreshLiveHost(
          session,
          runtime.eventStatus === 'open',
          reconcile,
        )
      )
        continue;
      refreshHost(sessionId).catch(() => undefined);
    }
  });

  const authenticateLockedApp = useCallback(async () => {
    if (appAuthenticationInFlightRef.current) return;
    appAuthenticationInFlightRef.current = true;
    setAppAccessAuthenticating(true);
    try {
      await authenticateAppAccess();
      setAppAccessLocked(false);
    } catch {
      // Cancellation and failed checks leave the app locked so the user can retry.
    } finally {
      appAuthenticationInFlightRef.current = false;
      setAppAccessAuthenticating(false);
    }
  }, []);

  const verifyBiometric = useCallback(async (): Promise<boolean> => {
    try {
      await authenticateAppAccess();
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'E_APP_AUTH_CANCELLED') {
        Alert.alert(
          t('settings.biometricUnavailable'),
          t('settings.biometricUnavailableCopy', { error: String(error) }),
        );
      }
      return false;
    }
  }, [t]);

  const unlockGlobalKeychain = useCallback(async (): Promise<GlobalSshKeyMaterial[] | null> => {
    try {
      return await unlockGlobalSshKeychain();
    } catch (error) {
      if ((error as { code?: string }).code !== 'E_GLOBAL_KEYCHAIN_CANCELLED') {
        Alert.alert(t('keychain.unlockError'), t('keychain.unlockErrorCopy', { error: String(error) }));
      }
      return null;
    }
  }, [t]);

  const openGlobalKeychain = async (): Promise<void> => {
    const keys = await unlockGlobalKeychain();
    if (keys !== null) setUnlockedGlobalKeys(keys);
  };

  const updateGlobalKeys = (keys: GlobalSshKeyMaterial[]) => {
    setUnlockedGlobalKeys(keys);
    setGlobalSshKeys(keys.map(({ secret: _secret, passphrase: _passphrase, ...key }) => key));
  };

  const confirmUnknownHost = useCallback((challenge: UnknownHostKeyChallenge): Promise<boolean> => (
    new Promise(resolve => {
      const displayHost = challenge.port === 22
        ? challenge.host
        : `[${challenge.host}]:${challenge.port}`;
      Alert.alert(
        t('knownHosts.trustTitle'),
        t('knownHosts.trustCopy', {
          host: displayHost,
          keyType: challenge.keyType,
          fingerprint: challenge.fingerprint,
        }),
        [
          { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('knownHosts.trust'), onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    })
  ), [t]);

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const action = biometricResumeAction(
        previousState,
        state,
        biometricOnResumeRef.current,
        preferencesLoadedRef.current,
      );
      previousState = state;
      if (action === 'lock') {
        setAppAccessLocked(true);
      } else if (action === 'authenticate') {
        setAppAccessLocked(true);
        authenticateLockedApp();
      }
    });
    return () => subscription.remove();
  }, [authenticateLockedApp]);

  const updateSecuritySetting = async (apply: () => void): Promise<void> => {
    if (securitySettingChangeInFlightRef.current) return;
    securitySettingChangeInFlightRef.current = true;
    try {
      if (await verifyBiometric()) apply();
    } finally {
      securitySettingChangeInFlightRef.current = false;
    }
  };

  const updateBiometricForKeys = async (enabled: boolean): Promise<void> => {
    await updateSecuritySetting(() => {
      biometricForKeysRef.current = enabled;
      setBiometricForKeys(enabled);
    });
  };

  const updateBiometricOnResume = async (enabled: boolean): Promise<void> => {
    await updateSecuritySetting(() => {
      biometricOnResumeRef.current = enabled;
      setBiometricOnResume(enabled);
      if (!enabled) setAppAccessLocked(false);
    });
  };

  useEffect(() => {
    if (liveSessions.sessions.length === 0) return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        resumeLiveConnections(true);
      }
    });
    const heartbeat = setInterval(() => {
      resumeLiveConnections(false);
    }, LIVE_HOST_HEALTHCHECK_MS);
    const reconciliation = setInterval(() => {
      resumeLiveConnections(true);
    }, LIVE_HOST_RECONCILE_MS);
    return () => {
      subscription.remove();
      clearInterval(heartbeat);
      clearInterval(reconciliation);
    };
  }, [liveSessions.sessions.length]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (knownHostsOpen) {
        setKnownHostsOpen(false);
        return true;
      }
      if (unlockedGlobalKeys !== null) {
        setUnlockedGlobalKeys(null);
        return true;
      }
      if (editorProfile) {
        setEditorProfile(null);
        setConnectError(null);
        return true;
      }
      if (selectedPaneId) {
        setSelectedPaneId(null);
        return true;
      }
      const result = handleMobileBack(navigation);
      if (result.handled) setNavigation(result.state);
      return result.handled;
    });
    return () => subscription.remove();
  }, [editorProfile, knownHostsOpen, navigation, selectedPaneId, unlockedGlobalKeys]);

  const selectTab = (tab: AppTab) => setNavigation(current => selectMobileTab(current, tab));

  const closeLiveHost = useCallback((sessionId: string) => {
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    if (session) savePersistedTerminals(session.hostId, session.terminals).catch(() => undefined);
    const runtime = runtimes.current.get(sessionId);
    if (runtime) {
      clearReconnect(runtime);
      clearEventTimers(runtime);
      runtime.refresh.invalidate();
      runtime.client.releaseAllTerminals()
        .finally(() => runtime.client.disconnect());
      runtimes.current.delete(sessionId);
    }
    setSelectedPaneId(null);
    setHerdHostFilterId(current => current === sessionId ? null : current);
    setHerdWorkspaceFilterIds(current => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setLiveSessions(current => {
      const next = closeLiveHostSession(current, sessionId);
      if (next.sessions.length === 0) {
        setNavigation(nav => selectMobileTab(nav, 'hosts'));
      }
      return next;
    });
  }, []);

  const connect = async (
    nextProfile: ConnectionProfile,
    options: ConnectOptions = {},
  ): Promise<boolean> => {
    const {
      persistProfile = true,
      navigate = true,
      markUsed = true,
      trackConnecting = true,
      activateSession = true,
      biometricVerified = false,
      promptForUnknownHosts = navigate,
    } = options;
    if (trackConnecting) {
      setConnecting(true);
      setConnectingHostId(nextProfile.id);
    }
    setConnectError(null);
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === nextProfile.id);
    if (existing) closeLiveHost(existing.id);
    let runtime: LiveRuntime | null = null;
    let liveSessionOpened = false;
    try {
      const jumpProfiles = await loadJumpHostConnectionProfiles(hostsRef.current, nextProfile);
      const jumpWithoutCredential = jumpProfiles.find(profile => !profile.secret);
      if (jumpWithoutCredential) {
        throw new Error(`${hostDisplayName(jumpWithoutCredential)} needs a saved SSH credential before it can be used as a jump host`);
      }
      const protectedConnection = [nextProfile, ...jumpProfiles].some(profile => (
        requiresBiometricForKeyUse(profile, biometricForKeysRef.current)
      ));
      if (!biometricVerified && protectedConnection) {
        if (!await verifyBiometric()) return false;
      }
      const saved = persistProfile
        ? await saveConnectionProfile(hostsRef.current, nextProfile)
        : {
          hosts: hostsRef.current,
          host: hostsRef.current.find(host => host.id === nextProfile.id),
        };
      if (!saved.host) throw new Error(`Saved host ${nextProfile.id} no longer exists`);
      const savedHost = saved.host;
      if (persistProfile) setHosts(saved.hosts);
      const sessionId = nextProfile.id;
      runtime = createRuntime(sessionId, nextProfile);
      let trustedKeys = 0;
      while (true) {
        try {
          await runtime.client.connect(nextProfile, jumpProfiles);
          break;
        } catch (error) {
          const challenge = parseUnknownHostKey(error);
          if (!challenge || !promptForUnknownHosts) throw error;
          if (trustedKeys >= jumpProfiles.length + 1) throw error;
          if (!await confirmUnknownHost(challenge)) {
            throw new Error(t('knownHosts.notTrusted'));
          }
          const nextKnownHosts = await trustKnownHost(knownHostsRef.current, challenge);
          knownHostsRef.current = nextKnownHosts;
          setKnownHosts(nextKnownHosts);
          trustedKeys += 1;
        }
      }
      const initial = await runtime.client.initialSnapshot();
      const restoredTerminals = await loadPersistedTerminals(nextProfile.id, initial);
      if (restoredTerminals.activeTerminalId) restoredTerminalHostIdsRef.current.add(nextProfile.id);
      runtime.previousStatuses = new Map(initial.agents.map(agent => [agent.pane_id, agent.agent_status]));
      // Publish only fully initialized transports. A failed first handshake is
      // an offline saved host, not a live session eligible for reconnect.
      runtimes.current.set(sessionId, runtime);
      setLiveSessions(current => {
        let next = openLiveHostSession(
          current,
          savedHost,
          sessionId,
          activateSession,
        );
        next = updateLiveHostConnection(next, sessionId, { status: 'connected' });
        const request = beginLiveHostSync(next, sessionId);
        next = applyLiveHostSnapshot(
          request.state,
          sessionId,
          request.generation,
          initial,
          new Date().toISOString(),
          null,
        );
        return replaceLiveHostTerminals(next, sessionId, restoredTerminals);
      });
      liveSessionOpened = true;
      setEditorProfile(null);
      if (navigate) {
        if (initial.server.running) {
          setNavigation(current => selectMobileTab(current, 'terminal'));
        } else {
          setHerdHostFilterId(sessionId);
          setNavigation(current => selectMobileTab(current, 'herd'));
        }
      }

      // The initial snapshot is sufficient to render the destination. Open the
      // event stream and persist recency after navigation so neither another
      // SSH channel nor local storage delays the visible connection.
      const connectedRuntime = runtime;
      ensureEventStream(sessionId, initial)
        .then(() => {
          if (initial.server.running) return refreshHost(sessionId);
          return undefined;
        })
        .catch(error => {
          connectedRuntime.eventStatus = 'closed';
          scheduleEventReconnect(sessionId, error);
        });
      if (markUsed) {
        markHostConnected(saved.hosts, nextProfile.id)
          .then(setHosts)
          .catch(() => undefined);
      }
      return true;
    } catch (error) {
      setConnectError(t(connectionErrorTranslationKeys[classifyConnectionError(error)], {
        host: hostKeyErrorHost(error) || hostDisplayName(nextProfile),
        ...connectionErrorContext(error),
      }));
      if (runtime) {
        if (liveSessionOpened) {
          scheduleReconnect(nextProfile.id, error);
        } else {
          runtime.refresh.invalidate();
          runtime.client.disconnect();
        }
      }
      if (navigate) setNavigation(current => selectMobileTab(current, 'hosts'));
      return false;
    } finally {
      if (trackConnecting) {
        setConnecting(false);
        setConnectingHostId(null);
      }
    }
  };

  const restorePersistedLiveHosts = useEffectEvent(async () => {
    const persisted = persistedLiveHostsRef.current;
    const persistedHosts = persisted.hostIds
      .map(hostId => hostsRef.current.find(item => item.id === hostId))
      .filter((host): host is HostProfile => Boolean(host));
    const hasProtectedKey = persistedHosts.some(host => {
      try {
        return [host, ...resolveJumpHostChain(hostsRef.current, host)].some(candidate => (
          requiresBiometricForSavedKey(candidate, biometricForKeysRef.current)
        ));
      } catch {
        return requiresBiometricForSavedKey(host, biometricForKeysRef.current);
      }
    });
    const protectedKeyAccessGranted = !hasProtectedKey || await verifyBiometric();
    await Promise.allSettled(persisted.hostIds.map(async hostId => {
      const host = hostsRef.current.find(item => item.id === hostId);
      if (!host) return;
      let protectedKey = requiresBiometricForSavedKey(host, biometricForKeysRef.current);
      try {
        protectedKey = [host, ...resolveJumpHostChain(hostsRef.current, host)].some(candidate => (
          requiresBiometricForSavedKey(candidate, biometricForKeysRef.current)
        ));
      } catch {
        // The normal connect path reports a missing or cyclic jump-host configuration.
      }
      if (protectedKey && !protectedKeyAccessGranted) return;
      try {
        const profile = await loadConnectionProfile(host);
        if (!profile.secret) return;
        await connect(profile, {
          persistProfile: false,
          navigate: false,
          markUsed: false,
          trackConnecting: false,
          activateSession: hostId === persisted.activeHostId,
          biometricVerified: protectedKey,
        });
      } catch (error) {
        setConnectError(t('app.restoreHostError', { host: hostDisplayName(host), error: String(error) }));
      }
    }));
    if (persisted.activeHostId) {
      setLiveSessions(current => {
        const active = current.sessions.find(session => session.hostId === persisted.activeHostId);
        return active ? selectLiveHostSession(current, active.id) : current;
      });
    }
    if (reopenTerminalOnLaunch) {
      const terminalHostId = persisted.activeHostId && restoredTerminalHostIdsRef.current.has(persisted.activeHostId)
        ? persisted.activeHostId
        : [...persisted.hostIds].reverse().find(hostId => restoredTerminalHostIdsRef.current.has(hostId));
      if (terminalHostId) {
        setLiveSessions(current => {
          const terminalHost = current.sessions.find(session => session.hostId === terminalHostId);
          return terminalHost ? selectLiveHostSession(current, terminalHost.id) : current;
        });
        setNavigation(current => selectMobileTab(current, 'terminal'));
      }
    }
    setLiveHostRestoreComplete(true);
  });

  useEffect(() => {
    if (!profilesLoaded || !preferencesLoaded || !liveHostsLoaded || !knownHostsLoaded || restoreStarted.current) return;
    restoreStarted.current = true;
    restorePersistedLiveHosts().catch(error => {
      setConnectError(t('app.restoreLiveHostsError', { error: String(error) }));
      setLiveHostRestoreComplete(true);
    });
  }, [knownHostsLoaded, liveHostsLoaded, preferencesLoaded, profilesLoaded, t]);

  const saveHost = async (nextProfile: ConnectionProfile) => {
    setConnectError(null);
    try {
      const saved = await saveConnectionProfile(hosts, nextProfile);
      setHosts(saved.hosts);
      setCredentialRecovery(await credentialRecoveryStatus());
      setEditorProfile(null);
    } catch (error) {
      setConnectError(t('app.saveHostError', { error: String(error) }));
    }
  };

  const openHostEditor = async (host: HostProfile) => {
    setConnectError(null);
    try {
      setEditorProfile(await loadConnectionProfile(host));
    } catch (error) {
      setConnectError(t('app.loadCredentialsError', { error: String(error) }));
    }
  };

  const unlockCredentialRecovery = async (): Promise<boolean> => {
    setCredentialRecoveryBusy(true);
    setConnectError(null);
    try {
      const result = await restoreCredentialBackups(hostsRef.current);
      setCredentialRecovery(await credentialRecoveryStatus());
      if (result.failed > 0) {
        setConnectError(t('app.restoreCredentialsPartial', { restored: result.restored, failed: result.failed }));
      }
      return result.restored > 0;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'E_CREDENTIAL_VAULT_CANCELLED') {
        setConnectError(t('app.restoreCredentialsError', { error: String(error) }));
      }
      setCredentialRecovery(await credentialRecoveryStatus());
      return false;
    } finally {
      setCredentialRecoveryBusy(false);
    }
  };

  const selectLiveHost = useCallback((sessionId: string, tab: AppTab = 'terminal') => {
    setSelectedPaneId(null);
    setLiveSessions(current => selectLiveHostSession(current, sessionId));
    setNavigation(current => selectMobileTab(current, tab));
  }, []);

  const setHerdWorkspaceFilter = useCallback((sessionId: string, workspaceId: string | null) => {
    setHerdWorkspaceFilterIds(current => current[sessionId] === workspaceId
      ? current
      : { ...current, [sessionId]: workspaceId });
  }, []);

  const exitTerminalToHerd = useCallback((sessionId: string) => {
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    const activeTerminalId = session?.terminals.activeTerminalId;
    const activePane = session?.snapshot.panes.find(pane => pane.terminal_id === activeTerminalId);
    const workspaceId = activePane?.workspace_id || session?.selection.workspaceId;
    setHerdHostFilterId(sessionId);
    if (workspaceId) setHerdWorkspaceFilter(sessionId, workspaceId);
    setNavigation(current => selectMobileTab(current, 'herd'));
  }, [setHerdWorkspaceFilter]);

  const connectSavedHost = async (host: HostProfile) => {
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === host.id);
    if (existing) {
      selectLiveHost(existing.id, 'terminal');
      refreshHost(existing.id).catch(error => scheduleReconnect(existing.id, error));
      return;
    }
    setConnectError(null);
    setConnectingHostId(host.id);
    try {
      let nextProfile = await loadConnectionProfile(host);
      if (!nextProfile.secret && credentialRecovery.state === 'locked') {
        const restored = await unlockCredentialRecovery();
        if (restored) nextProfile = await loadConnectionProfile(host);
      }
      if (!nextProfile.secret) {
        setEditorProfile(nextProfile);
        setConnectError(t('app.enterCredential'));
        return;
      }
      await connect(nextProfile, { persistProfile: false });
    } catch (error) {
      setConnectError(String(error));
    } finally {
      setConnectingHostId(null);
    }
  };

  const confirmDeleteHost = (target: HostProfile) => {
    Alert.alert(t('app.deleteHostTitle'), t('app.deleteHostCopy', { host: hostDisplayName(target) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          const live = liveSessionsRef.current.sessions.find(session => session.hostId === target.id);
          if (live) closeLiveHost(live.id);
          deleteHostProfile(hosts, target.id)
            .then(async next => {
              setHosts(next);
              setCredentialRecovery(await credentialRecoveryStatus());
              setEditorProfile(null);
              setConnectError(null);
            })
            .catch(error => setConnectError(t('app.deleteHostError', { error: String(error) })));
        },
      },
    ]);
  };

  const activatePaneTerminal = useCallback((sessionId: string, pane: PaneInfo) => {
    setLiveSessions(current => updateLiveHostTerminals(current, sessionId, terminals => openTerminalSession(terminals, pane)));
  }, []);

  const openSshShell = useCallback((sessionId: string) => {
    setSelectedPaneId(null);
    setLiveSessions(current => updateLiveHostTerminals(
      current,
      sessionId,
      terminals => openSshShellSession(terminals, t('terminal.sshShell')),
    ));
    selectLiveHost(sessionId, 'terminal');
  }, [selectLiveHost, t]);

  const openPaneTerminal = (sessionId: string, pane: PaneInfo, focusAgent = false) => {
    setSelectedPaneId(null);
    setLiveSessions(current => updateLiveHostTerminals(
      current,
      sessionId,
      terminals => openTerminalSession(terminals, pane),
    ));
    selectLiveHost(sessionId, 'terminal');
    const runtime = runtimes.current.get(sessionId);
    const focus = focusAgent
      ? runtime?.client.focusAgent(pane.pane_id)
      : runtime?.client.focusPane(pane.pane_id);
    focus?.then(() => refreshHost(sessionId))
      .catch(error => scheduleReconnect(sessionId, error));
  };

  const openNotificationTarget = useEffectEvent((): boolean => {
    if (!notificationResponse) return false;
    const target = parseAgentNotificationTarget(
      notificationResponse,
      Notifications.DEFAULT_ACTION_IDENTIFIER,
    );
    if (!target || handledNotificationIdRef.current === target.notificationId) return false;
    const resolved = resolveAgentNotificationTarget(liveSessionsRef.current, target);
    if (!resolved) return false;
    handledNotificationIdRef.current = target.notificationId;
    setEditorProfile(null);
    setConnectError(null);
    openPaneTerminal(resolved.sessionId, resolved.pane, true);
    Notifications.clearLastNotificationResponse();
    setNotificationResponse(null);
    return true;
  });

  useEffect(() => {
    if (!liveHostRestoreComplete || !notificationResponse) return;
    openNotificationTarget();
  }, [liveHostRestoreComplete, liveSessions, notificationResponse]);

  const closeTerminal = useCallback((sessionId: string, terminalId: string) => {
    runtimes.current.get(sessionId)?.client.closeTerminalBridge(terminalId).catch(() => undefined);
    setLiveSessions(current => updateLiveHostTerminals(current, sessionId, terminals => closeTerminalSession(terminals, terminalId)));
  }, []);

  const updateTerminalStatus = useCallback((
    sessionId: string,
    terminalId: string,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => {
    setLiveSessions(current => updateLiveHostTerminals(current, sessionId, terminals => updateTerminalSession(terminals, terminalId, {
      status,
      error,
      reconnectAttempt: reconnectAttempt ?? (status === 'connected' ? 0 : undefined),
    })));
  }, []);

  const activeSession = getActiveLiveHostSession(liveSessions);
  const activeRuntime = activeSession ? runtimes.current.get(activeSession.id) : undefined;
  const activeClient = activeRuntime?.client;
  const terminalTargets: TerminalRenderTarget[] = useMemo(
    () =>
      liveSessions.sessions.flatMap(session => {
        const runtime = runtimes.current.get(session.id);
        if (!runtime) return [];
        return session.terminals.sessions.map(terminal => ({
          key: terminalRendererKey(session.id, terminal.terminalId),
          hostSessionId: session.id,
          client: runtime.client,
          session: terminal,
          scroll: session.snapshot.panes.find(
            pane => pane.terminal_id === terminal.terminalId,
          )?.scroll,
        }));
      }),
    [liveSessions.sessions],
  );
  const snapshot = activeSession?.snapshot;
  const selectedPane = selectedPaneId && snapshot
    ? snapshot.panes.find(pane => pane.pane_id === selectedPaneId) || null
    : null;
  const selectedHerdHostId = herdHostFilterId && liveSessions.sessions.some(session => session.id === herdHostFilterId)
    ? herdHostFilterId
    : null;
  const selectedHerdWorkspaceId = selectedHerdHostId
    ? herdWorkspaceFilterIds[selectedHerdHostId] ?? null
    : null;
  const herdQueues: HerdHostQueue[] = useMemo(
    () =>
      liveSessions.sessions.map(session => ({
        id: session.id,
        label: hostDisplayName(session.host),
        address: session.host.host,
        running: session.snapshot.server.running,
        refreshing: session.sync.status === 'syncing',
        agents: session.snapshot.agents,
        workspaces: session.snapshot.workspaces,
        tabs: session.snapshot.tabs,
      })),
    [liveSessions.sessions],
  );

  const refreshActive = async () => {
    if (activeSession) await refreshHost(activeSession.id);
  };

  const refreshHerd = async () => {
    const sessionIds = selectedHerdHostId
      ? [selectedHerdHostId]
      : liveSessions.sessions.map(session => session.id);
    await Promise.all(sessionIds.map(refreshHost));
  };

  const openAgentTerminal = (sessionId: string, agent: AgentInfo) => {
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    const pane = session?.snapshot.panes.find(item => item.pane_id === agent.pane_id);
    if (!pane) return;
    openPaneTerminal(sessionId, pane, true);
  };

  const selectHerdHost = (sessionId: string | null) => {
    setHerdHostFilterId(sessionId);
    if (sessionId) setLiveSessions(current => selectLiveHostSession(current, sessionId));
  };

  const selectHerdWorkspace = async (sessionId: string, workspaceId: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    setLiveSessions(current => applyLiveHostFocus(current, sessionId, { workspaceId }));
    await runtime.client.focusWorkspace(workspaceId);
    await refreshHost(sessionId);
  };

  const openHerdWorkspace = async (sessionId: string, workspaceId: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    setLiveSessions(current => applyLiveHostFocus(current, sessionId, { workspaceId }));
    selectLiveHost(sessionId, 'terminal');
    await runtime.client.focusWorkspace(workspaceId);
    const refreshedSnapshot = await refreshHostSnapshot(sessionId);
    const workspace = refreshedSnapshot?.workspaces.find(item => item.workspace_id === workspaceId);
    const tabId = workspace?.active_tab_id
      || refreshedSnapshot?.tabs.find(item => item.workspace_id === workspaceId && item.focused)?.tab_id
      || refreshedSnapshot?.tabs.find(item => item.workspace_id === workspaceId)?.tab_id;
    const pane = refreshedSnapshot?.panes.find(item => item.tab_id === tabId && item.focused)
      || refreshedSnapshot?.panes.find(item => item.tab_id === tabId);
    if (pane) {
      openPaneTerminal(sessionId, pane);
    } else {
      setLiveSessions(current => updateLiveHostTerminals(
        current,
        sessionId,
        terminals => ({ ...terminals, activeTerminalId: null }),
      ));
    }
  };

  const createHerdWorkspace = async (sessionId: string, name: string, cwd: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    await runtime.client.createWorkspace(name, cwd);
    await refreshHost(sessionId);
  };

  const renameHerdWorkspace = async (sessionId: string, workspaceId: string, name: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    await runtime.client.renameWorkspace(workspaceId, name);
    await refreshHost(sessionId);
  };

  const closeHerdWorkspace = async (sessionId: string, workspaceId: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    await runtime.client.closeWorkspace(workspaceId);
    await refreshHost(sessionId);
  };

  const closeHerdTab = async (sessionId: string, tabId: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    await runtime.client.closeTab(tabId);
    await refreshHost(sessionId);
  };

  const openCreatedHerdPane = async (sessionId: string, paneId: string) => {
    const refreshedSnapshot = await refreshHostSnapshot(sessionId);
    const pane = refreshedSnapshot?.panes.find(item => item.pane_id === paneId);
    if (pane) openPaneTerminal(sessionId, pane);
    else selectLiveHost(sessionId, 'terminal');
  };

  const startHerdAgent = async (
    sessionId: string,
    workspaceId: string,
    tabName: string,
    command: string,
  ) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    const paneId = await runtime.client.startAgent(workspaceId, tabName, command);
    await openCreatedHerdPane(sessionId, paneId);
  };

  const runHerdCommand = async (
    sessionId: string,
    workspaceId: string,
    tabName: string,
    command: string,
  ) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    const paneId = await runtime.client.runCommand(workspaceId, tabName, command);
    recordTerminalHistoryEntry(command);
    await openCreatedHerdPane(sessionId, paneId);
  };

  const startServer = async (sessionId: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) return;
    try {
      await runtime.client.startServer();
      await new Promise<void>(resolve => setTimeout(resolve, 800));
      await refreshHost(sessionId);
    } catch (error) {
      scheduleReconnect(sessionId, error);
    }
  };

  if (!profilesLoaded || !preferencesLoaded || !liveHostsLoaded || !knownHostsLoaded || !terminalHistoryLoaded) {
    return <View className="flex-1 items-center justify-center bg-background"><WhipMark accessibilityLabel={t('app.loading')} size={64} /></View>;
  }

  const terminalVisible = navigation.tab === 'terminal' && !editorProfile;
  const immersiveTerminal = terminalVisible && Boolean(activeSession);
  const activeTerminalVisible =
    immersiveTerminal && Boolean(activeSession?.terminals.activeTerminalId);
  const fullscreenTerminalVisible =
    activeTerminalVisible && terminalPreferences.fullscreen;
  const fullscreenVisible = immersiveTerminal
    ? fullscreenTerminalVisible
    : fullscreenApp;
  const railSessions: LiveSessionRailItem[] = liveSessions.sessions.map(session => ({
    hostId: session.id,
    label: hostDisplayName(session.host),
    status: session.status === 'disconnected' ? 'error' : session.status,
    agentStatus: aggregateAgentStatus(session.snapshot.workspaces.map(workspace => workspace.agent_status)),
    terminalCount: session.terminals.sessions.length,
  }));

  return (
    <>
      <StatusBar
        animated
        hidden={fullscreenVisible}
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={theme.canvas}
      />
      <SafeAreaView
        className="flex-1 bg-background"
        edges={fullscreenVisible ? ['left', 'right'] : ['top', 'left', 'right']}>
      <TerminalVolumeKeyBinding
        enabled={activeTerminalVisible}
        volumeUpAction={terminalPreferences.volumeUpAction}
        volumeDownAction={terminalPreferences.volumeDownAction}
      />
      {keepScreenOn && activeTerminalVisible ? <TerminalKeepAwake /> : null}
      <GlassProvider
        blurTarget={navigationBlurTargetRef}
        enabled={appGlassEnabled && Boolean(appBackgroundImageUri)}>
      <View className="flex-1 bg-background">
        <NavigationBlurTarget ref={navigationBlurTargetRef} style={styles.navigationBlurTarget}>
          {/* Keep these screens mounted: rebuilding Herd's populated native tree made
              release tab switches stall, while Terminal was already instant because
              it used this same hide-without-unmounting pattern. */}
          <View
            importantForAccessibility={immersiveTerminal ? 'no-hide-descendants' : 'auto'}
            pointerEvents={immersiveTerminal ? 'none' : 'auto'}
            style={immersiveTerminal ? styles.hiddenTab : styles.tabScreen}>
          <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
          <View
            importantForAccessibility={navigation.tab === 'hosts' ? 'auto' : 'no-hide-descendants'}
            pointerEvents={navigation.tab === 'hosts' ? 'auto' : 'none'}
            style={navigation.tab === 'hosts' ? styles.tabScreen : styles.hiddenTab}>
            <HostsScreen
              hosts={hosts}
              activeHostId={activeSession?.hostId || null}
              connectedHostIds={liveSessions.sessions.map(session => session.hostId)}
              latencyMsByHostId={Object.fromEntries(liveSessions.sessions.map(session => [
                session.hostId,
                session.status === 'connected' ? session.sync.latencyMs : null,
              ]))}
              connectingHostId={connectingHostId}
              error={connectError}
              credentialRecovery={credentialRecovery}
              credentialRecoveryBusy={credentialRecoveryBusy}
              onAdd={() => {
                setConnectError(null);
                setEditorProfile(emptyConnectionProfile());
              }}
              onConnect={host => connectSavedHost(host).catch(error => setConnectError(String(error)))}
              onDelete={confirmDeleteHost}
              onDisconnect={host => {
                const live = liveSessionsRef.current.sessions.find(session => session.hostId === host.id);
                if (live) closeLiveHost(live.id);
              }}
              onEdit={openHostEditor}
              onUnlockCredentials={unlockCredentialRecovery}
            />
          </View>

          <View
            importantForAccessibility={navigation.tab === 'herd' ? 'auto' : 'no-hide-descendants'}
            pointerEvents={navigation.tab === 'herd' ? 'auto' : 'none'}
            style={navigation.tab === 'herd' ? styles.tabScreen : styles.hiddenTab}>
            {liveSessions.sessions.length > 0 ? (
              <HerdScreen
                queues={herdQueues}
                sessions={railSessions}
                selectedHostId={selectedHerdHostId}
                workspaceFilterId={selectedHerdWorkspaceId}
                agentCommand={agentCommand}
                commandHistory={terminalHistory}
                onSelectHost={selectHerdHost}
                onWorkspaceFilterChange={setHerdWorkspaceFilter}
                onCloseHost={closeLiveHost}
                onNewHost={() => selectTab('hosts')}
                onSelectWorkspace={selectHerdWorkspace}
                onCreateWorkspace={createHerdWorkspace}
                onRenameWorkspace={renameHerdWorkspace}
                onCloseWorkspace={closeHerdWorkspace}
                onCloseTab={closeHerdTab}
                onRefresh={refreshHerd}
                onOpenTerminal={openAgentTerminal}
                onStartAgent={startHerdAgent}
                onRunCommand={runHerdCommand}
                onOpenSpace={openHerdWorkspace}
                onStartServer={startServer}
                onOpenSshShell={openSshShell}
              />
            ) : <ConnectRequiredScreen destination={t('nav.herd')} onPickHost={() => selectTab('hosts')} />}
          </View>

          {!activeSession && navigation.tab === 'terminal' && (
            <ConnectRequiredScreen destination={t('nav.terminal')} onPickHost={() => selectTab('hosts')} />
          )}

          <View
            importantForAccessibility={navigation.tab === 'more' ? 'auto' : 'no-hide-descendants'}
            pointerEvents={navigation.tab === 'more' ? 'auto' : 'none'}
            style={navigation.tab === 'more' ? styles.tabScreen : styles.hiddenTab}>
            <MoreScreen
              alertsEnabled={alertsEnabled}
              persistentAlertDurationSeconds={persistentAlertDurationSeconds}
              ttsEnabled={ttsEnabled}
              biometricForKeys={biometricForKeys}
              biometricOnResume={biometricOnResume}
              globalKeyCount={globalSshKeys.length}
              knownHostCount={knownHosts.length}
              appearance={appearance}
              fullscreenApp={fullscreenApp}
              appBackgroundImageUri={appBackgroundImageUri}
              appBackgroundDimming={appBackgroundDimming}
              appGlassEnabled={appGlassEnabled}
              language={language}
              keepScreenOn={keepScreenOn}
              reopenTerminalOnLaunch={reopenTerminalOnLaunch}
              agentCommand={agentCommand}
              terminalHistory={terminalHistory}
              terminalPreferences={terminalPreferences}
              server={activeSession?.snapshot.server || null}
              onAlertsChange={setAlertsEnabled}
              onPersistentAlertDurationChange={setPersistentAlertDurationSeconds}
              onTtsChange={setTtsEnabled}
              onBiometricForKeysChange={value => { updateBiometricForKeys(value).catch(() => undefined); }}
              onBiometricOnResumeChange={value => { updateBiometricOnResume(value).catch(() => undefined); }}
              onManageGlobalKeychain={() => { openGlobalKeychain().catch(() => undefined); }}
              onManageKnownHosts={() => setKnownHostsOpen(true)}
              onAppearanceChange={updateAppearance}
              onFullscreenAppChange={setFullscreenApp}
              onAppBackgroundImageChange={setAppBackgroundImageUri}
              onAppBackgroundDimmingChange={setAppBackgroundDimming}
              onAppGlassEnabledChange={setAppGlassEnabled}
              onLanguageChange={setLanguage}
              onKeepScreenOnChange={setKeepScreenOn}
              onReopenTerminalOnLaunchChange={setReopenTerminalOnLaunch}
              onAgentCommandChange={setAgentCommand}
              onDeleteTerminalHistory={deleteTerminalHistoryEntries}
              onTerminalPreferencesChange={setTerminalPreferences}
            />
          </View>

          </View>

        {activeSession && activeRuntime && (
          <LiveSessionView
            session={activeSession}
            client={activeRuntime.client}
            visible={terminalVisible}
            terminalTargets={terminalTargets}
            terminalPreferences={terminalPreferences}
            terminalControlUsage={terminalControlUsage}
            terminalHistory={terminalHistory}
            onTerminalControlUse={recordTerminalControlUse}
            onTerminalHistoryEntry={recordTerminalHistoryEntry}
            onTerminalOpenLinksInAppChange={updateTerminalOpenLinksInApp}
            onExit={() => exitTerminalToHerd(activeSession.id)}
            onRefresh={refreshHost}
            onOpenPane={(sessionId, pane) => {
              setLiveSessions(current => selectLiveHostSession(current, sessionId));
              setSelectedPaneId(pane.pane_id);
            }}
            onActivateTerminal={activatePaneTerminal}
            onCloseTerminal={closeTerminal}
            onTerminalStatus={updateTerminalStatus}
          />
        )}
        </NavigationBlurTarget>

        {!immersiveTerminal && !editorProfile && unlockedGlobalKeys === null && !knownHostsOpen && (
          <BottomNavigation activeTab={navigation.tab} blurTarget={navigationBlurTargetRef} onSelect={selectTab} />
        )}

        {editorProfile && (
          <View className="absolute inset-0 z-40 bg-background">
            <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
            <ConnectionScreen
              key={editorProfile.id}
              initialProfile={editorProfile}
              hosts={hosts}
              connecting={connecting}
              error={connectError}
              onCancel={() => {
                setEditorProfile(null);
                setConnectError(null);
              }}
              onSave={saveHost}
              onConnect={connect}
              onDelete={hosts.some(host => host.id === editorProfile.id) ? () => confirmDeleteHost(editorProfile) : undefined}
              onAuthenticatePrivateKey={biometricForKeys ? verifyBiometric : undefined}
              onLoadGlobalKeys={unlockGlobalKeychain}
            />
          </View>
        )}

        {unlockedGlobalKeys !== null && (
          <View className="absolute inset-0 z-50 bg-background">
            <GlobalKeychainScreen
              initialKeys={unlockedGlobalKeys}
              onChanged={updateGlobalKeys}
              onClose={() => setUnlockedGlobalKeys(null)}
            />
          </View>
        )}

        {knownHostsOpen && (
          <View className="absolute inset-0 z-60 bg-background">
            <KnownHostsScreen
              initialHosts={knownHosts}
              onChanged={next => {
                knownHostsRef.current = next;
                setKnownHosts(next);
              }}
              onClose={() => setKnownHostsOpen(false)}
            />
          </View>
        )}
      </View>

      {activeClient && (
        <PaneDetail
          pane={selectedPane}
          client={activeClient}
          onClose={() => setSelectedPaneId(null)}
          onChanged={refreshActive}
          onOpenTerminal={pane => activeSession && openPaneTerminal(activeSession.id, pane)}
        />
      )}
      <AppAccessLock
        authenticating={appAccessAuthenticating}
        visible={appAccessLocked}
        onRetry={() => { authenticateLockedApp(); }}
      />
        </GlassProvider>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  navigationBlurTarget: {
    flex: 1,
  },
  tabScreen: {
    flex: 1,
  },
  hiddenTab: {
    position: 'absolute',
    inset: 0,
    opacity: 0,
  },
});

function TerminalKeepAwake() {
  useKeepAwake('herdr-terminal');
  return null;
}

function TerminalVolumeKeyBinding({
  enabled,
  volumeUpAction,
  volumeDownAction,
}: {
  enabled: boolean;
  volumeUpAction: TerminalVolumeKeyAction;
  volumeDownAction: TerminalVolumeKeyAction;
}) {
  useEffect(() => {
    configureTerminalVolumeKeys(enabled, volumeUpAction, volumeDownAction);
    return () => configureTerminalVolumeKeys(false, 'none', 'none');
  }, [enabled, volumeDownAction, volumeUpAction]);
  return null;
}

function LiveSessionView({
  session,
  client,
  visible,
  terminalTargets,
  terminalPreferences,
  terminalControlUsage,
  terminalHistory,
  onTerminalControlUse,
  onTerminalHistoryEntry,
  onTerminalOpenLinksInAppChange,
  onExit,
  onRefresh,
  onOpenPane,
  onActivateTerminal,
  onCloseTerminal,
  onTerminalStatus,
}: {
  session: LiveHostSession;
  client: HerdrClient;
  visible: boolean;
  terminalTargets: readonly TerminalRenderTarget[];
  terminalPreferences: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
  terminalHistory: readonly string[];
  onTerminalControlUse: (control: TerminalControlId) => void;
  onTerminalHistoryEntry: (entry: string) => void;
  onTerminalOpenLinksInAppChange: (value: boolean) => void;
  onExit: () => void;
  onRefresh: (sessionId: string) => Promise<void>;
  onOpenPane: (sessionId: string, pane: PaneInfo) => void;
  onActivateTerminal: (sessionId: string, pane: PaneInfo) => void;
  onCloseTerminal: (sessionId: string, terminalId: string) => void;
  onTerminalStatus: (sessionId: string, terminalId: string, status: TerminalSessionStatus, error?: string, reconnectAttempt?: number) => void;
}) {
  const sessionId = session.id;
  const refresh = useCallback(() => onRefresh(sessionId), [onRefresh, sessionId]);
  const openPane = useCallback((pane: PaneInfo) => onOpenPane(sessionId, pane), [onOpenPane, sessionId]);
  const activateTerminal = useCallback((pane: PaneInfo) => onActivateTerminal(sessionId, pane), [onActivateTerminal, sessionId]);
  const closeTerminal = useCallback((terminalId: string) => onCloseTerminal(sessionId, terminalId), [onCloseTerminal, sessionId]);

  return (
    <SessionScreen
      hostSessionId={sessionId}
      visible={visible}
      snapshot={session.snapshot}
      client={client}
      terminalState={session.terminals}
      terminalTargets={terminalTargets}
      onRefresh={refresh}
      onOpenPane={openPane}
      onActivateTerminal={activateTerminal}
      onCloseTerminal={closeTerminal}
      onTerminalStatus={onTerminalStatus}
      terminalPreferences={terminalPreferences}
      terminalControlUsage={terminalControlUsage}
      terminalHistory={terminalHistory}
      onTerminalControlUse={onTerminalControlUse}
      onTerminalHistoryEntry={onTerminalHistoryEntry}
      onTerminalOpenLinksInAppChange={onTerminalOpenLinksInAppChange}
      onExit={onExit}
    />
  );
}

export default App;
