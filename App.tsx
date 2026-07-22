import './global.css';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { useKeepAwake } from 'expo-keep-awake';
import { useLocales } from 'expo-localization';
import { PortalHost } from '@rn-primitives/portal';
import { Alert, Appearance, AppState, BackHandler, Platform, StatusBar, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { BottomNavigation } from './src/components/BottomNavigation';
import { AppAccessLock } from './src/components/AppAccessLock';
import { ConnectionScreen } from './src/components/ConnectionScreen';
import { ConnectRequiredScreen } from './src/components/ConnectRequiredScreen';
import { HerdScreen } from './src/components/HerdScreen';
import { GlobalKeychainScreen } from './src/components/GlobalKeychainScreen';
import { HostsScreen } from './src/components/HostsScreen';
import type { LiveSessionRailItem } from './src/components/LiveSessionRail';
import { MoreScreen } from './src/components/MoreScreen';
import { PaneDetail } from './src/components/PaneDetail';
import { SessionScreen } from './src/components/SessionScreen';
import { WhipMark } from './src/components/app-ui';
import type { HerdHostQueue } from './src/herdQueue';
import { emptyConnectionProfile, hostDisplayName } from './src/lib/hostProfiles';
import { resolveColorScheme } from './src/lib/appearance';
import { biometricResumeAction } from './src/lib/appAccess';
import { requiresBiometricForKeyUse, requiresBiometricForSavedKey } from './src/lib/biometricSecurity';
import {
  activeTabSuppressesNotifications,
  agentFromStatusEvent,
  tabNameForAgent,
  agentStatusFromEvent,
  shouldNotifyAgentTransition,
} from './src/lib/agentStatusEvents';
import { isHerdrProtocolMismatch } from './src/lib/herdrProtocol';
import { nextReconnect } from './src/lib/reconnectPolicy';
import {
  incrementTerminalControlUsage,
  type TerminalControlId,
  type TerminalControlUsage,
} from './src/lib/terminalControls';
import {
  parseAgentNotificationTarget,
  resolveAgentNotificationTarget,
} from './src/lib/notificationNavigation';
import { createRefreshCoordinator, type RefreshCoordinator } from './src/lib/refreshCoordinator';
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
  markHostConnected,
  saveConnectionProfile,
} from './src/services/hostProfiles';
import {
  credentialRecoveryStatus,
  restoreCredentialBackups,
  type CredentialRecoveryStatus,
} from './src/services/credentialVault';
import { loadGlobalSshKeys, unlockGlobalSshKeychain } from './src/services/globalSshKeychain';
import { loadPersistedTerminals, savePersistedTerminals } from './src/services/persistedTerminals';
import {
  loadPersistedLiveHosts,
  savePersistedLiveHosts,
  type PersistedLiveHosts,
} from './src/services/persistedLiveHosts';
import {
  closeTerminalSession,
  openTerminalSession,
  reconcileTerminalSessions,
  updateTerminalSession,
  type TerminalSessionStatus,
} from './src/terminalSessions';
import { useTheme } from './src/theme';
import type { AgentInfo, AgentStatus, AppTab, ConnectionProfile, GlobalSshKey, GlobalSshKeyMaterial, HerdrSnapshot, HostProfile, PaneInfo } from './src/types';
import type { HerdrApiEvent } from './src/lib/herdrApiBridge';
import i18n, { languageForLocale } from './src/i18n';

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
  eventRefreshTimer: ReturnType<typeof setTimeout> | null;
}

interface SnapshotMeasurement {
  snapshot: HerdrSnapshot;
  latencyMs: number;
}

interface ConnectOptions {
  persistProfile?: boolean;
  navigate?: boolean;
  markUsed?: boolean;
  trackConnecting?: boolean;
  activateSession?: boolean;
  biometricVerified?: boolean;
}

let retainedBackgroundRuntimes: Map<string, LiveRuntime> | null = null;

function disposeRuntimes(target: Map<string, LiveRuntime>): void {
  for (const runtime of target.values()) {
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    if (runtime.eventReconnectTimer) clearTimeout(runtime.eventReconnectTimer);
    if (runtime.eventRefreshTimer) clearTimeout(runtime.eventRefreshTimer);
    runtime.refresh.invalidate();
    runtime.client.releaseAllTerminals()
      .finally(() => runtime.client.disconnect());
  }
  target.clear();
}

function App() {
  const { colors: theme, isDark } = useTheme();
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={theme.canvas} />
      <AppContent />
      <PortalHost />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const { t } = useTranslation();
  const locales = useLocales();
  const runtimes = useRef(new Map<string, LiveRuntime>());
  const liveSessionsRef = useRef(emptyLiveHostSessions);
  const hostsRef = useRef<HostProfile[]>([]);
  const persistedLiveHostsRef = useRef<PersistedLiveHosts>({ hostIds: [], activeHostId: null });
  const restoredTerminalHostIdsRef = useRef(new Set<string>());
  const restoreStarted = useRef(false);
  const alertsEnabledRef = useRef(true);
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
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [liveHostsLoaded, setLiveHostsLoaded] = useState(false);
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
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [biometricForKeys, setBiometricForKeys] = useState(defaultDevicePreferences.biometricForKeys);
  const [biometricOnResume, setBiometricOnResume] = useState(defaultDevicePreferences.biometricOnResume);
  const [appAccessLocked, setAppAccessLocked] = useState(false);
  const [appAccessAuthenticating, setAppAccessAuthenticating] = useState(false);
  const [appearance, setAppearance] = useState<AppearancePreference>(defaultDevicePreferences.appearance);
  const [language, setLanguage] = useState<LanguagePreference>(defaultDevicePreferences.language);
  const [keepScreenOn, setKeepScreenOn] = useState(defaultDevicePreferences.keepScreenOn);
  const [reopenTerminalOnLaunch, setReopenTerminalOnLaunch] = useState(defaultDevicePreferences.reopenTerminalOnLaunch);
  const [terminalPreferences, setTerminalPreferences] = useState<TerminalPreferences>(defaultDevicePreferences.terminal);
  const [terminalControlUsage, setTerminalControlUsage] = useState<TerminalControlUsage>(defaultDevicePreferences.terminalControlUsage);
  const [credentialRecovery, setCredentialRecovery] = useState<CredentialRecoveryStatus>({ state: 'none', count: 0 });
  const [credentialRecoveryBusy, setCredentialRecoveryBusy] = useState(false);
  const applyAppearance = useEffectEvent((value: AppearancePreference) => {
    Appearance.setColorScheme(resolveColorScheme(value));
  });
  const resolvedLanguage = language === 'system' ? languageForLocale(locales[0]) : language;

  useEffect(() => {
    i18n.changeLanguage(resolvedLanguage).catch(() => undefined);
  }, [resolvedLanguage]);

  const updateTerminalFontSize = useCallback((fontSize: number) => {
    const nextFontSize = Math.max(8, Math.min(24, Math.round(fontSize)));
    setTerminalPreferences(current => (
      current.fontSize === nextFontSize
        ? current
        : { ...current, fontSize: nextFontSize }
    ));
  }, []);

  const recordTerminalControlUse = useCallback((control: TerminalControlId) => {
    setTerminalControlUsage(current => incrementTerminalControlUsage(current, control));
  }, []);

  liveSessionsRef.current = liveSessions;
  hostsRef.current = hosts;
  alertsEnabledRef.current = alertsEnabled;
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
    prepareAlerts().catch(() => undefined);
    loadDevicePreferences()
      .then(preferences => {
        setAlertsEnabled(preferences.alertsEnabled);
        setTtsEnabled(preferences.ttsEnabled);
        biometricForKeysRef.current = preferences.biometricForKeys;
        setBiometricForKeys(preferences.biometricForKeys);
        biometricOnResumeRef.current = preferences.biometricOnResume;
        setBiometricOnResume(preferences.biometricOnResume);
        setAppearance(preferences.appearance);
        setLanguage(preferences.language);
        setKeepScreenOn(preferences.keepScreenOn);
        setReopenTerminalOnLaunch(preferences.reopenTerminalOnLaunch);
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
  }, [t]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    saveDevicePreferences({
      alertsEnabled,
      ttsEnabled,
      biometricForKeys,
      biometricOnResume,
      appearance,
      language,
      keepScreenOn,
      reopenTerminalOnLaunch,
      lastTab: navigation.tab,
      terminal: terminalPreferences,
      terminalControlUsage,
    }).catch(() => undefined);
  }, [alertsEnabled, appearance, biometricForKeys, biometricOnResume, keepScreenOn, language, navigation.tab, preferencesLoaded, reopenTerminalOnLaunch, terminalControlUsage, terminalPreferences, ttsEnabled]);

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
    if (runtime.eventRefreshTimer) clearTimeout(runtime.eventRefreshTimer);
    runtime.eventReconnectTimer = null;
    runtime.eventRefreshTimer = null;
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
          if (
            agentStatus
            && agent
            && alertsEnabledRef.current
            && shouldNotifyAgentTransition(
              previous,
              agentStatus,
              activeTabSuppressesNotifications(
                agent,
                session?.snapshot.tabs ?? [],
                AppState.currentState === 'active',
                liveSessionsRef.current.activeSessionId === sessionId,
              ),
            )
          ) {
            alertAgent(agent, ttsEnabledRef.current, {
              hostId: sessionId,
              paneId,
            }, session ? tabNameForAgent(agent, session.snapshot.tabs) : undefined).catch(() => undefined);
          }
          if (agentStatus) runtime.previousStatuses?.set(paneId, agentStatus);
          setLiveSessions(current => applyLiveHostAgentStatus(current, sessionId, paneId, event.data));
        }
        if (runtime.eventRefreshTimer) return;
        runtime.eventRefreshTimer = setTimeout(() => {
          runtime.eventRefreshTimer = null;
          refreshHost(sessionId).catch(() => undefined);
        }, 120);
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
      eventRefreshTimer: null,
    } as LiveRuntime;
    runtime.refresh = createRefreshCoordinator(
      async () => {
        setLiveSessions(current => beginLiveHostSync(current, sessionId).state);
        const startedAt = Date.now();
        const snapshot = await runtime.client.snapshot();
        return { snapshot, latencyMs: elapsedLatencyMs(startedAt) };
      },
      measurement => {
        if (runtimes.current.get(sessionId) !== runtime) return;
        const { snapshot, latencyMs } = measurement;
        const statuses = new Map(snapshot.agents.map(agent => [agent.pane_id, agent.agent_status]));
        if (alertsEnabledRef.current && runtime.previousStatuses) {
          for (const agent of snapshot.agents) {
            const previous = runtime.previousStatuses.get(agent.pane_id);
            if (shouldNotifyAgentTransition(
              previous,
              agent.agent_status,
              activeTabSuppressesNotifications(
                agent,
                snapshot.tabs,
                AppState.currentState === 'active',
                liveSessionsRef.current.activeSessionId === sessionId,
              ),
            )) {
              alertAgent(agent, ttsEnabledRef.current, {
                hostId: sessionId,
                paneId: agent.pane_id,
              }, tabNameForAgent(agent, snapshot.tabs)).catch(() => undefined);
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

  async function refreshHost(sessionId: string): Promise<void> {
    const runtime = runtimes.current.get(sessionId);
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    if (!runtime || !canRefreshLiveHostSession(session)) return;
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
    } else if (result.status === 'failed') {
      setLiveSessions(current => {
        const currentSession = findLiveHostSession(current, sessionId);
        if (!currentSession) return current;
        return failLiveHostSync(current, sessionId, currentSession.sync.generation, String(result.error));
      });
      scheduleReconnect(sessionId, result.error);
    }
  }

  const resumeLiveConnections = useEffectEvent(() => {
    for (const sessionId of runtimes.current.keys()) {
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
        resumeLiveConnections();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [liveSessions.sessions.length]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
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
  }, [editorProfile, navigation, selectedPaneId, unlockedGlobalKeys]);

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
    } = options;
    if (trackConnecting) {
      setConnecting(true);
      setConnectingHostId(nextProfile.id);
    }
    setConnectError(null);
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === nextProfile.id);
    if (existing) closeLiveHost(existing.id);
    let runtime: LiveRuntime | null = null;
    try {
      if (!biometricVerified && requiresBiometricForKeyUse(nextProfile, biometricForKeysRef.current)) {
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
      runtimes.current.set(sessionId, runtime);
      setLiveSessions(current => openLiveHostSession(
        current,
        savedHost,
        sessionId,
        activateSession,
      ));
      await runtime.client.connect(nextProfile);
      const initialSnapshotStartedAt = Date.now();
      const initial = await runtime.client.snapshot();
      const initialLatencyMs = elapsedLatencyMs(initialSnapshotStartedAt);
      const restoredTerminals = await loadPersistedTerminals(nextProfile.id, initial);
      if (restoredTerminals.activeTerminalId) restoredTerminalHostIdsRef.current.add(nextProfile.id);
      runtime.previousStatuses = new Map(initial.agents.map(agent => [agent.pane_id, agent.agent_status]));
      setLiveSessions(current => {
        let next = updateLiveHostConnection(current, sessionId, { status: 'connected' });
        const request = beginLiveHostSync(next, sessionId);
        next = applyLiveHostSnapshot(
          request.state,
          sessionId,
          request.generation,
          initial,
          new Date().toISOString(),
          initialLatencyMs,
        );
        return replaceLiveHostTerminals(next, sessionId, restoredTerminals);
      });
      try {
        await ensureEventStream(sessionId, initial);
      } catch (error) {
        runtime.eventStatus = 'closed';
        scheduleEventReconnect(sessionId, error);
      }
      setEditorProfile(null);
      if (markUsed) {
        const usedHosts = await markHostConnected(saved.hosts, nextProfile.id);
        setHosts(usedHosts);
      }
      if (navigate) setNavigation(current => selectMobileTab(current, 'terminal'));
      return true;
    } catch (error) {
      setConnectError(String(error));
      if (runtime) scheduleReconnect(nextProfile.id, error);
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
    const hasProtectedKey = persistedHosts.some(host => (
      requiresBiometricForSavedKey(host, biometricForKeysRef.current)
    ));
    const protectedKeyAccessGranted = !hasProtectedKey || await verifyBiometric();
    await Promise.allSettled(persisted.hostIds.map(async hostId => {
      const host = hostsRef.current.find(item => item.id === hostId);
      if (!host) return;
      const protectedKey = requiresBiometricForSavedKey(host, biometricForKeysRef.current);
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
    if (!profilesLoaded || !preferencesLoaded || !liveHostsLoaded || restoreStarted.current) return;
    restoreStarted.current = true;
    restorePersistedLiveHosts().catch(error => {
      setConnectError(t('app.restoreLiveHostsError', { error: String(error) }));
      setLiveHostRestoreComplete(true);
    });
  }, [liveHostsLoaded, preferencesLoaded, profilesLoaded, t]);

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
      await connect(nextProfile);
    } catch (error) {
      setConnectError(String(error));
    } finally {
      setConnectingHostId(null);
    }
  };

  const confirmDeleteHost = (target: ConnectionProfile) => {
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
  const herdQueues: HerdHostQueue[] = liveSessions.sessions.map(session => ({
    id: session.id,
    label: hostDisplayName(session.host),
    address: session.host.host,
    running: session.snapshot.server.running,
    refreshing: session.sync.status === 'syncing',
    agents: session.snapshot.agents,
    workspaces: session.snapshot.workspaces,
    tabs: session.snapshot.tabs,
  }));

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
    const session = findLiveHostSession(liveSessions, sessionId);
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
    await runtime.client.focusWorkspace(workspaceId);
    await refreshHost(sessionId);
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

  const startAgent = async (sessionId: string, name: string, command: string, cwd: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) return;
    await runtime.client.startAgent(name, command, cwd);
    await refreshHost(sessionId);
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

  if (!profilesLoaded || !preferencesLoaded || !liveHostsLoaded) {
    return <View className="flex-1 items-center justify-center bg-background"><WhipMark accessibilityLabel={t('app.loading')} size={64} /></View>;
  }

  const terminalVisible = navigation.tab === 'terminal' && !editorProfile;
  const immersiveTerminal = terminalVisible && Boolean(activeSession);
  const activeTerminalVisible = immersiveTerminal && Boolean(activeSession?.terminals.activeTerminalId);
  const totalTerminalCount = liveSessions.sessions.reduce((total, session) => total + session.terminals.sessions.length, 0);
  const railSessions: LiveSessionRailItem[] = liveSessions.sessions.map(session => ({
    hostId: session.id,
    label: hostDisplayName(session.host),
    status: session.status === 'disconnected' ? 'error' : session.status,
    agentStatus: aggregateAgentStatus(session.snapshot.workspaces.map(workspace => workspace.agent_status)),
    terminalCount: session.terminals.sessions.length,
  }));

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom', 'left', 'right']}>
      {keepScreenOn && activeTerminalVisible ? <TerminalKeepAwake /> : null}
      <View className="flex-1 bg-background">
        <View className="flex-1 bg-background">
          {navigation.tab === 'hosts' && (
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
              onEdit={openHostEditor}
              onUnlockCredentials={unlockCredentialRecovery}
            />
          )}

          {navigation.tab === 'herd' && (
            liveSessions.sessions.length > 0 ? (
              <HerdScreen
                queues={herdQueues}
                sessions={railSessions}
                selectedHostId={selectedHerdHostId}
                workspaceFilterId={selectedHerdWorkspaceId}
                onSelectHost={selectHerdHost}
                onWorkspaceFilterChange={setHerdWorkspaceFilter}
                onCloseHost={closeLiveHost}
                onNewHost={() => selectTab('hosts')}
                onSelectWorkspace={selectHerdWorkspace}
                onCreateWorkspace={createHerdWorkspace}
                onRenameWorkspace={renameHerdWorkspace}
                onCloseWorkspace={closeHerdWorkspace}
                onRefresh={refreshHerd}
                onOpenTerminal={openAgentTerminal}
                onStart={startAgent}
                onStartServer={startServer}
              />
            ) : <ConnectRequiredScreen destination={t('nav.herd')} onPickHost={() => selectTab('hosts')} />
          )}

          {!activeSession && navigation.tab === 'terminal' && (
            <ConnectRequiredScreen destination={t('nav.terminal')} onPickHost={() => selectTab('hosts')} />
          )}

          {navigation.tab === 'more' && (
            <MoreScreen
              connectedHost={activeSession ? hostDisplayName(activeSession.host) : null}
              host={activeSession?.host.host || null}
              alertsEnabled={alertsEnabled}
              ttsEnabled={ttsEnabled}
              biometricForKeys={biometricForKeys}
              biometricOnResume={biometricOnResume}
              globalKeyCount={globalSshKeys.length}
              appearance={appearance}
              language={language}
              keepScreenOn={keepScreenOn}
              reopenTerminalOnLaunch={reopenTerminalOnLaunch}
              terminalPreferences={terminalPreferences}
              server={activeSession?.snapshot.server || null}
              onAlertsChange={setAlertsEnabled}
              onTtsChange={setTtsEnabled}
              onBiometricForKeysChange={value => { updateBiometricForKeys(value).catch(() => undefined); }}
              onBiometricOnResumeChange={value => { updateBiometricOnResume(value).catch(() => undefined); }}
              onManageGlobalKeychain={() => { openGlobalKeychain().catch(() => undefined); }}
              onAppearanceChange={updateAppearance}
              onLanguageChange={setLanguage}
              onKeepScreenOnChange={setKeepScreenOn}
              onReopenTerminalOnLaunchChange={setReopenTerminalOnLaunch}
              onTerminalPreferencesChange={setTerminalPreferences}
              onDisconnect={activeSession ? () => closeLiveHost(activeSession.id) : undefined}
            />
          )}

          {liveSessions.sessions.map(session => {
            const runtime = runtimes.current.get(session.id);
            if (!runtime) return null;
            return (
              <LiveSessionView
                key={session.id}
                session={session}
                client={runtime.client}
                visible={terminalVisible && session.id === activeSession?.id}
                terminalPreferences={terminalPreferences}
                terminalControlUsage={terminalControlUsage}
                onTerminalFontSizeChange={updateTerminalFontSize}
                onTerminalControlUse={recordTerminalControlUse}
                onExit={() => exitTerminalToHerd(session.id)}
                onRefresh={refreshHost}
                onOpenPane={(sessionId, pane) => {
                  setLiveSessions(current => selectLiveHostSession(current, sessionId));
                  setSelectedPaneId(pane.pane_id);
                }}
                onActivateTerminal={activatePaneTerminal}
                onCloseTerminal={closeTerminal}
                onTerminalStatus={updateTerminalStatus}
              />
            );
          })}
        </View>

        {!immersiveTerminal && !editorProfile && unlockedGlobalKeys === null && (
          <BottomNavigation activeTab={navigation.tab} sessionCount={totalTerminalCount} onSelect={selectTab} />
        )}

        {editorProfile && (
          <View className="absolute inset-0 z-40 bg-background">
            <ConnectionScreen
              key={editorProfile.id}
              initialProfile={editorProfile}
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
    </SafeAreaView>
  );
}

function TerminalKeepAwake() {
  useKeepAwake('herdr-terminal');
  return null;
}

function LiveSessionView({
  session,
  client,
  visible,
  terminalPreferences,
  terminalControlUsage,
  onTerminalFontSizeChange,
  onTerminalControlUse,
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
  terminalPreferences: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
  onTerminalFontSizeChange: (fontSize: number) => void;
  onTerminalControlUse: (control: TerminalControlId) => void;
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
  const terminalStatus = useCallback((terminalId: string, status: TerminalSessionStatus, error?: string, reconnectAttempt?: number) => (
    onTerminalStatus(sessionId, terminalId, status, error, reconnectAttempt)
  ), [onTerminalStatus, sessionId]);

  return (
    <SessionScreen
      visible={visible}
      snapshot={session.snapshot}
      client={client}
      terminalState={session.terminals}
      onRefresh={refresh}
      onOpenPane={openPane}
      onActivateTerminal={activateTerminal}
      onCloseTerminal={closeTerminal}
      onTerminalStatus={terminalStatus}
      terminalPreferences={terminalPreferences}
      terminalControlUsage={terminalControlUsage}
      onTerminalFontSizeChange={onTerminalFontSizeChange}
      onTerminalControlUse={onTerminalControlUse}
      onExit={onExit}
    />
  );
}

function elapsedLatencyMs(startedAt: number): number {
  return Math.max(1, Date.now() - startedAt);
}

export default App;
