import './global.css';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { PortalHost } from '@rn-primitives/portal';
import { Alert, Appearance, AppState, BackHandler, Platform, StatusBar, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { BottomNavigation } from './src/components/BottomNavigation';
import { ConnectionScreen } from './src/components/ConnectionScreen';
import { ConnectRequiredScreen } from './src/components/ConnectRequiredScreen';
import { HerdScreen } from './src/components/HerdScreen';
import { HostsScreen } from './src/components/HostsScreen';
import { LiveSessionRail, type LiveSessionRailItem } from './src/components/LiveSessionRail';
import { MoreScreen } from './src/components/MoreScreen';
import { PaneDetail } from './src/components/PaneDetail';
import { SessionScreen } from './src/components/SessionScreen';
import { SettingsScreen } from './src/components/SettingsScreen';
import { hapticPress, WhipMark } from './src/components/app-ui';
import { Button } from './src/components/ui/button';
import { Text } from './src/components/ui/text';
import { emptyConnectionProfile, hostDisplayName } from './src/lib/hostProfiles';
import { resolveColorScheme } from './src/lib/appearance';
import {
  agentFromStatusEvent,
  tabNameForAgent,
  agentStatusFromEvent,
  shouldNotifyAgentTransition,
} from './src/lib/agentStatusEvents';
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
  applyLiveHostFocus,
  applyLiveHostSnapshot,
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
  popMobileScreen,
  pushMobileScreen,
  selectMobileTab,
} from './src/mobileNavigation';
import { alertAgent, prepareAlerts } from './src/services/alerts';
import { startBackgroundMonitoring, stopBackgroundMonitoring } from './src/services/backgroundMonitoring';
import {
  defaultDevicePreferences,
  loadDevicePreferences,
  saveDevicePreferences,
  type AppearancePreference,
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
import type { AgentInfo, AgentStatus, AppTab, ConnectionProfile, HerdrSnapshot, HostProfile, PaneInfo } from './src/types';
import type { HerdrApiEvent } from './src/lib/herdrApiBridge';

interface LiveRuntime {
  client: HerdrClient;
  profile: ConnectionProfile;
  refresh: RefreshCoordinator<HerdrSnapshot>;
  previousStatuses: Map<string, AgentStatus> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  eventPaneKey: string | null;
  eventStatus: 'closed' | 'opening' | 'open';
  eventReconnectAttempts: number;
  eventReconnectTimer: ReturnType<typeof setTimeout> | null;
  eventRefreshTimer: ReturnType<typeof setTimeout> | null;
}

interface ConnectOptions {
  persistProfile?: boolean;
  navigate?: boolean;
  markUsed?: boolean;
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
  const runtimes = useRef(new Map<string, LiveRuntime>());
  const liveSessionsRef = useRef(emptyLiveHostSessions);
  const hostsRef = useRef<HostProfile[]>([]);
  const persistedLiveHostsRef = useRef<PersistedLiveHosts>({ hostIds: [], activeHostId: null });
  const restoreStarted = useRef(false);
  const alertsEnabledRef = useRef(true);
  const ttsEnabledRef = useRef(false);
  const handledNotificationIdRef = useRef<string | null>(null);
  const [notificationResponse, setNotificationResponse] = useState<Notifications.NotificationResponse | null>(null);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [editorProfile, setEditorProfile] = useState<ConnectionProfile | null>(null);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [liveHostsLoaded, setLiveHostsLoaded] = useState(false);
  const [liveHostRestoreComplete, setLiveHostRestoreComplete] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [liveSessions, setLiveSessions] = useState(emptyLiveHostSessions);
  const [navigation, setNavigation] = useState(initialMobileNavigation);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [appearance, setAppearance] = useState<AppearancePreference>(defaultDevicePreferences.appearance);
  const [terminalPreferences, setTerminalPreferences] = useState<TerminalPreferences>(defaultDevicePreferences.terminal);
  const [terminalControlUsage, setTerminalControlUsage] = useState<TerminalControlUsage>(defaultDevicePreferences.terminalControlUsage);
  const [credentialRecovery, setCredentialRecovery] = useState<CredentialRecoveryStatus>({ state: 'none', count: 0 });
  const [credentialRecoveryBusy, setCredentialRecoveryBusy] = useState(false);
  const applyAppearance = useEffectEvent((value: AppearancePreference) => {
    Appearance.setColorScheme(resolveColorScheme(value));
  });

  const updateTerminalFontSize = useCallback((fontSize: number) => {
    const nextFontSize = Math.max(8, Math.min(16, Math.round(fontSize)));
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
      .catch(error => setConnectError(`Could not load saved hosts: ${String(error)}`))
      .finally(() => setProfilesLoaded(true));
    prepareAlerts().catch(() => undefined);
    loadDevicePreferences()
      .then(preferences => {
        setAlertsEnabled(preferences.alertsEnabled);
        setTtsEnabled(preferences.ttsEnabled);
        setAppearance(preferences.appearance);
        applyAppearance(preferences.appearance);
        setTerminalPreferences(preferences.terminal);
        setTerminalControlUsage(preferences.terminalControlUsage);
        setNavigation(current => selectMobileTab(current, preferences.lastTab));
      })
      .finally(() => setPreferencesLoaded(true));
    loadPersistedLiveHosts()
      .then(value => {
        persistedLiveHostsRef.current = value;
      })
      .finally(() => setLiveHostsLoaded(true));
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    saveDevicePreferences({
      alertsEnabled,
      ttsEnabled,
      appearance,
      lastTab: navigation.tab,
      terminal: terminalPreferences,
      terminalControlUsage,
    }).catch(() => undefined);
  }, [alertsEnabled, appearance, navigation.tab, preferencesLoaded, terminalControlUsage, terminalPreferences, ttsEnabled]);

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
    operation.catch(error => setConnectError(`Background monitoring unavailable: ${String(error)}`));
  }, [alertsEnabled, liveHostRestoreComplete, liveSessions.sessions.length]);

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
    runtime.eventReconnectTimer = setTimeout(() => {
      runtime.eventReconnectTimer = null;
      const session = findLiveHostSession(liveSessionsRef.current, sessionId);
      if (!session || runtimes.current.get(sessionId) !== runtime) return;
      ensureEventStream(sessionId, session.snapshot, true).catch(error => {
        scheduleEventReconnect(sessionId, error || cause);
      });
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
            && shouldNotifyAgentTransition(previous, agentStatus, AppState.currentState !== 'active')
          ) {
            alertAgent(agent, ttsEnabledRef.current, {
              hostId: sessionId,
              paneId,
            }, session ? tabNameForAgent(agent, session.snapshot.tabs) : undefined).catch(() => undefined);
          }
          if (agentStatus) runtime.previousStatuses?.set(paneId, agentStatus);
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
        scheduleEventReconnect(sessionId, reason || 'Herdr event bridge closed');
      },
    );
    if (runtimes.current.get(sessionId) !== runtime) return;
    runtime.eventStatus = 'open';
    runtime.eventReconnectAttempts = 0;
  }

  const scheduleReconnect = (sessionId: string, cause: unknown) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime || runtime.reconnectTimer) return;
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
        return runtime.client.snapshot();
      },
      snapshot => {
        if (runtimes.current.get(sessionId) !== runtime) return;
        const statuses = new Map(snapshot.agents.map(agent => [agent.pane_id, agent.agent_status]));
        if (alertsEnabledRef.current && runtime.previousStatuses) {
          for (const agent of snapshot.agents) {
            const previous = runtime.previousStatuses.get(agent.pane_id);
            if (shouldNotifyAgentTransition(
              previous,
              agent.agent_status,
              AppState.currentState !== 'active',
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
          const updated = applyLiveHostSnapshot(current, sessionId, session.sync.generation, snapshot, new Date().toISOString());
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
      runtime.client.prepareTerminalBridge().catch(() => undefined);
      try {
        await ensureEventStream(sessionId, result.value);
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
  }, [editorProfile, navigation, selectedPaneId]);

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
    const { persistProfile = true, navigate = true, markUsed = true } = options;
    setConnecting(true);
    setConnectingHostId(nextProfile.id);
    setConnectError(null);
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === nextProfile.id);
    if (existing) closeLiveHost(existing.id);
    let runtime: LiveRuntime | null = null;
    try {
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
      setLiveSessions(current => openLiveHostSession(current, savedHost, sessionId));
      await runtime.client.connect(nextProfile);
      const initial = await runtime.client.snapshot();
      runtime.client.prepareTerminalBridge().catch(() => undefined);
      const restoredTerminals = await loadPersistedTerminals(nextProfile.id, initial);
      runtime.previousStatuses = new Map(initial.agents.map(agent => [agent.pane_id, agent.agent_status]));
      setLiveSessions(current => {
        let next = updateLiveHostConnection(current, sessionId, { status: 'connected' });
        const request = beginLiveHostSync(next, sessionId);
        next = applyLiveHostSnapshot(request.state, sessionId, request.generation, initial, new Date().toISOString());
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
      setConnecting(false);
      setConnectingHostId(null);
    }
  };

  const restorePersistedLiveHosts = useEffectEvent(async () => {
    const persisted = persistedLiveHostsRef.current;
    for (const hostId of persisted.hostIds) {
      const host = hostsRef.current.find(item => item.id === hostId);
      if (!host) continue;
      try {
        const profile = await loadConnectionProfile(host);
        if (!profile.secret) continue;
        await connect(profile, { persistProfile: false, navigate: false, markUsed: false });
      } catch (error) {
        setConnectError(`Could not restore ${hostDisplayName(host)}: ${String(error)}`);
      }
    }
    if (persisted.activeHostId) {
      setLiveSessions(current => {
        const active = current.sessions.find(session => session.hostId === persisted.activeHostId);
        return active ? selectLiveHostSession(current, active.id) : current;
      });
    }
    setLiveHostRestoreComplete(true);
  });

  useEffect(() => {
    if (!profilesLoaded || !preferencesLoaded || !liveHostsLoaded || restoreStarted.current) return;
    restoreStarted.current = true;
    restorePersistedLiveHosts().catch(error => {
      setConnectError(`Could not restore live hosts: ${String(error)}`);
      setLiveHostRestoreComplete(true);
    });
  }, [liveHostsLoaded, preferencesLoaded, profilesLoaded]);

  const saveHost = async (nextProfile: ConnectionProfile) => {
    setConnectError(null);
    try {
      const saved = await saveConnectionProfile(hosts, nextProfile);
      setHosts(saved.hosts);
      setCredentialRecovery(await credentialRecoveryStatus());
      setEditorProfile(null);
    } catch (error) {
      setConnectError(`Could not save host: ${String(error)}`);
    }
  };

  const openHostEditor = async (host: HostProfile) => {
    setConnectError(null);
    try {
      setEditorProfile(await loadConnectionProfile(host));
    } catch (error) {
      setConnectError(`Could not load credentials: ${String(error)}`);
    }
  };

  const unlockCredentialRecovery = async (): Promise<boolean> => {
    setCredentialRecoveryBusy(true);
    setConnectError(null);
    try {
      const result = await restoreCredentialBackups(hostsRef.current);
      setCredentialRecovery(await credentialRecoveryStatus());
      if (result.failed > 0) {
        setConnectError(`Restored ${result.restored} credentials; ${result.failed} could not be decrypted.`);
      }
      return result.restored > 0;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'E_CREDENTIAL_VAULT_CANCELLED') {
        setConnectError(`Could not restore credentials: ${String(error)}`);
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

  const connectSavedHost = async (host: HostProfile) => {
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === host.id);
    if (existing) {
      selectLiveHost(existing.id, 'terminal');
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
        setConnectError('Enter this host credential before connecting. Enable Remember credentials to use one-tap connect next time.');
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
    Alert.alert('Delete host?', `${hostDisplayName(target)} and its saved credential will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
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
            .catch(error => setConnectError(`Could not delete host: ${String(error)}`));
        },
      },
    ]);
  };

  const activatePaneTerminal = useCallback((sessionId: string, pane: PaneInfo) => {
    setLiveSessions(current => updateLiveHostTerminals(current, sessionId, terminals => openTerminalSession(terminals, pane)));
  }, []);

  const openPaneTerminal = (sessionId: string, pane: PaneInfo, focusAgent = false) => {
    setSelectedPaneId(null);
    setLiveSessions(current => {
      const activated = updateLiveHostTerminals(current, sessionId, terminals => openTerminalSession(terminals, pane));
      return applyLiveHostFocus(activated, sessionId, { paneId: pane.pane_id });
    });
    selectLiveHost(sessionId, 'terminal');
    const runtime = runtimes.current.get(sessionId);
    const focus = focusAgent
      ? runtime?.client.focusAgent(pane.pane_id)
      : runtime?.client.focusPane(pane.pane_id);
    focus?.then(() => refreshHost(sessionId))
      .catch(() => undefined);
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

  const refreshActive = async () => {
    if (activeSession) await refreshHost(activeSession.id);
  };

  const openAgentTerminal = (agent: AgentInfo) => {
    if (!activeSession) return;
    const pane = activeSession.snapshot.panes.find(item => item.pane_id === agent.pane_id);
    if (!pane) return;
    openPaneTerminal(activeSession.id, pane);
  };

  const startAgent = async (name: string, command: string, cwd: string) => {
    if (!activeClient || !activeSession) return;
    await activeClient.startAgent(name, command, cwd);
    await refreshHost(activeSession.id);
  };

  const startServer = async () => {
    if (!activeClient || !activeSession) return;
    try {
      await activeClient.startServer();
      await new Promise<void>(resolve => setTimeout(resolve, 800));
      await refreshHost(activeSession.id);
    } catch (error) {
      scheduleReconnect(activeSession.id, error);
    }
  };

  if (!profilesLoaded || !preferencesLoaded || !liveHostsLoaded || !liveHostRestoreComplete) {
    return <View className="flex-1 items-center justify-center bg-background"><WhipMark accessibilityLabel="Whip is loading" size={64} /></View>;
  }

  const topScreen = navigation.stack[navigation.stack.length - 1];
  const terminalVisible = navigation.tab === 'terminal' && !topScreen && !editorProfile;
  const immersiveTerminal = terminalVisible && Boolean(activeSession);
  const totalTerminalCount = liveSessions.sessions.reduce((total, session) => total + session.terminals.sessions.length, 0);
  const railSessions: LiveSessionRailItem[] = liveSessions.sessions.map(session => ({
    hostId: session.id,
    label: hostDisplayName(session.host),
    status: session.status === 'disconnected' ? 'error' : session.status,
    terminalCount: session.terminals.sessions.length,
  }));

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom', 'left', 'right']}>
      <View className="flex-1 bg-background">
        <View className="flex-1 bg-background">
          {navigation.tab === 'hosts' && (
            <HostsScreen
              hosts={hosts}
              activeHostId={activeSession?.hostId || null}
              connectedHostIds={liveSessions.sessions.map(session => session.hostId)}
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
            activeSession && activeClient ? (
              <View className="flex-1 bg-background">
                <ConnectedHeader session={activeSession} />
                <View className="flex-1">
                  {!activeSession.snapshot.server.running ? (
                    <View className="flex-1 items-center justify-center bg-background p-8">
                      <View className="size-16 items-center justify-center rounded-full bg-destructive/10"><Text className="text-[28px] font-bold text-destructive">!</Text></View>
                      <Text className="mt-[18px] text-[21px] font-semibold leading-[27px]">Herdr server is offline</Text>
                      <Text className="mt-2 max-w-[330px] text-center text-[15px] leading-[22px] text-muted-foreground">Start the headless runtime on the host, then manage the session from this client.</Text>
                      <Button className="mt-6 rounded-full px-5" disabled={activeSession.sync.status === 'syncing'} onPress={hapticPress(startServer)}><Text>{activeSession.sync.status === 'syncing' ? 'Starting…' : 'Start Herdr server'}</Text></Button>
                    </View>
                  ) : (
                    <HerdScreen
                      agents={activeSession.snapshot.agents}
                      tabs={activeSession.snapshot.tabs}
                      refreshing={activeSession.sync.status === 'syncing'}
                      onRefresh={refreshActive}
                      onOpenTerminal={openAgentTerminal}
                      onStart={startAgent}
                    />
                  )}
                </View>
              </View>
            ) : <ConnectRequiredScreen destination="HERD" onPickHost={() => selectTab('hosts')} />
          )}

          {!activeSession && navigation.tab === 'terminal' && (
            <ConnectRequiredScreen destination="TERMINAL" onPickHost={() => selectTab('hosts')} />
          )}

          {navigation.tab === 'more' && (
            <MoreScreen
              connectedHost={activeSession ? hostDisplayName(activeSession.host) : null}
              onOpenSettings={() => setNavigation(current => pushMobileScreen(current, 'settings'))}
            />
          )}

          {activeSession && terminalVisible && (
            <LiveSessionRail
              sessions={railSessions}
              activeHostId={activeSession.id}
              onExit={() => setNavigation(current => selectMobileTab(current, current.lastNonTerminalTab))}
              onSelect={selectLiveHost}
              onClose={closeLiveHost}
              onNew={() => selectTab('hosts')}
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

        {!immersiveTerminal && !topScreen && !editorProfile && (
          <BottomNavigation activeTab={navigation.tab} sessionCount={totalTerminalCount} onSelect={selectTab} />
        )}

        {topScreen === 'settings' && (
          <View className="absolute inset-0 z-40 bg-background">
            <SettingsScreen
              host={activeSession?.host.host || null}
              alertsEnabled={alertsEnabled}
              ttsEnabled={ttsEnabled}
              appearance={appearance}
              terminalPreferences={terminalPreferences}
              onBack={() => setNavigation(popMobileScreen)}
              onAlertsChange={setAlertsEnabled}
              onTtsChange={setTtsEnabled}
              onAppearanceChange={updateAppearance}
              onTerminalPreferencesChange={setTerminalPreferences}
              onDisconnect={activeSession ? () => closeLiveHost(activeSession.id) : undefined}
            />
          </View>
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
    </SafeAreaView>
  );
}

function LiveSessionView({
  session,
  client,
  visible,
  terminalPreferences,
  terminalControlUsage,
  onTerminalFontSizeChange,
  onTerminalControlUse,
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
      onExit={() => undefined}
      showExit={false}
    />
  );
}

function ConnectedHeader({ session }: { session: LiveHostSession }) {
  const syncError = session.sync.error || session.connectionError;
  return (
    <View className="min-h-16 flex-row items-center justify-between border-b border-border bg-background px-4">
      <View className="min-w-0 flex-1 pr-2.5">
        <Text numberOfLines={1} className="text-[17px] font-semibold leading-[22px]">{hostDisplayName(session.host)}</Text>
        <Text numberOfLines={1} className="mt-0.5 text-xs leading-4 text-muted-foreground">{session.host.host} · {session.snapshot.server.running ? `Herdr ${session.snapshot.server.version || ''}`.trim() : 'Server offline'}</Text>
      </View>
      <View className={syncError ? 'flex-row items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1.5' : 'flex-row items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1.5'}>
        <View className={syncError ? 'size-1.5 rounded-full bg-destructive' : 'size-1.5 rounded-full bg-success'} />
        <Text className={syncError ? 'text-xs font-semibold text-destructive' : 'text-xs font-semibold text-success'}>{syncError ? 'Sync lost' : 'SSH live'}</Text>
      </View>
    </View>
  );
}

export default App;
