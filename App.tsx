import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { Alert, AppState, BackHandler, Platform, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
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
import { emptyConnectionProfile, hostDisplayName } from './src/lib/hostProfiles';
import { nextReconnect } from './src/lib/reconnectPolicy';
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
import { colors, useTheme } from './src/theme';
import type { AgentInfo, AppTab, ConnectionProfile, HerdrSnapshot, HostProfile, PaneInfo } from './src/types';
import type { HerdrApiEvent } from './src/lib/herdrApiBridge';

interface LiveRuntime {
  client: HerdrClient;
  profile: ConnectionProfile;
  refresh: RefreshCoordinator<HerdrSnapshot>;
  previousStatuses: Map<string, string> | null;
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
    </SafeAreaProvider>
  );
}

function AppContent() {
  const { colors: theme } = useTheme();
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
  const [terminalPreferences, setTerminalPreferences] = useState<TerminalPreferences>(defaultDevicePreferences.terminal);

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
      .then(setHosts)
      .catch(error => setConnectError(`Could not load saved hosts: ${String(error)}`))
      .finally(() => setProfilesLoaded(true));
    prepareAlerts().catch(() => undefined);
    loadDevicePreferences()
      .then(preferences => {
        setAlertsEnabled(preferences.alertsEnabled);
        setTtsEnabled(preferences.ttsEnabled);
        setTerminalPreferences(preferences.terminal);
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
      lastTab: navigation.tab,
      terminal: terminalPreferences,
    }).catch(() => undefined);
  }, [alertsEnabled, navigation.tab, preferencesLoaded, terminalPreferences, ttsEnabled]);

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
            if (previous && previous !== agent.agent_status && ['blocked', 'done'].includes(agent.agent_status)) {
              alertAgent(agent, ttsEnabledRef.current, {
                hostId: sessionId,
                paneId: agent.pane_id,
              }).catch(() => undefined);
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
      const nextProfile = await loadConnectionProfile(host);
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
            .then(next => {
              setHosts(next);
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
    return <View style={[styles.loading, { backgroundColor: theme.canvas }]}><View style={[styles.loadingBadge, { backgroundColor: theme.primary }]}><Text style={[styles.loadingMark, { color: theme.onPrimary }]}>H</Text></View></View>;
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
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.canvas }]} edges={['top', 'bottom', 'left', 'right']}>
      <View style={[styles.shell, { backgroundColor: theme.canvas }]}>
        <View style={[styles.body, { backgroundColor: theme.canvas }]}>
          {navigation.tab === 'hosts' && (
            <HostsScreen
              hosts={hosts}
              activeHostId={activeSession?.hostId || null}
              connectedHostIds={liveSessions.sessions.map(session => session.hostId)}
              connectingHostId={connectingHostId}
              error={connectError}
              onAdd={() => {
                setConnectError(null);
                setEditorProfile(emptyConnectionProfile());
              }}
              onConnect={host => connectSavedHost(host).catch(error => setConnectError(String(error)))}
              onEdit={openHostEditor}
            />
          )}

          {navigation.tab === 'herd' && (
            activeSession && activeClient ? (
              <View style={[styles.connectedPage, { backgroundColor: theme.canvas }]}>
                <ConnectedHeader session={activeSession} />
                <View style={styles.connectedBody}>
                  {!activeSession.snapshot.server.running ? (
                    <View style={[styles.offline, { backgroundColor: theme.canvas }]}>
                      <View style={[styles.offlineIcon, { backgroundColor: `${theme.error}14` }]}><Text style={[styles.offlineNumber, { color: theme.error }]}>!</Text></View>
                      <Text style={[styles.offlineTitle, { color: theme.text }]}>Herdr server is offline</Text>
                      <Text style={[styles.offlineCopy, { color: theme.textSecondary }]}>Start the headless runtime on the host, then manage the session from this client.</Text>
                      <Pressable disabled={activeSession.sync.status === 'syncing'} onPress={startServer} style={[styles.startServer, { backgroundColor: theme.primary }]}>
                        <Text style={[styles.startServerText, { color: theme.onPrimary }]}>{activeSession.sync.status === 'syncing' ? 'Starting…' : 'Start Herdr server'}</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <HerdScreen
                      agents={activeSession.snapshot.agents}
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
          <View style={[styles.overlay, { backgroundColor: theme.canvas }]}>
            <SettingsScreen
              host={activeSession?.host.host || null}
              alertsEnabled={alertsEnabled}
              ttsEnabled={ttsEnabled}
              terminalPreferences={terminalPreferences}
              onBack={() => setNavigation(popMobileScreen)}
              onAlertsChange={setAlertsEnabled}
              onTtsChange={setTtsEnabled}
              onTerminalPreferencesChange={setTerminalPreferences}
              onDisconnect={activeSession ? () => closeLiveHost(activeSession.id) : undefined}
            />
          </View>
        )}

        {editorProfile && (
          <View style={[styles.overlay, { backgroundColor: theme.canvas }]}>
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
      onExit={() => undefined}
      showExit={false}
    />
  );
}

function ConnectedHeader({ session }: { session: LiveHostSession }) {
  const { colors: theme } = useTheme();
  const syncError = session.sync.error || session.connectionError;
  return (
    <View style={[styles.topbar, { backgroundColor: theme.canvas, borderBottomColor: theme.divider }]}>
      <View style={styles.headerBody}>
        <Text numberOfLines={1} style={[styles.topTitle, { color: theme.text }]}>{hostDisplayName(session.host)}</Text>
        <Text numberOfLines={1} style={[styles.topMeta, { color: theme.textSecondary }]}>{session.host.host} · {session.snapshot.server.running ? `Herdr ${session.snapshot.server.version || ''}`.trim() : 'Server offline'}</Text>
      </View>
      <View style={[styles.link, { backgroundColor: syncError ? `${theme.error}14` : `${theme.done}14` }]}>
        <View style={[styles.linkDot, { backgroundColor: syncError ? theme.error : theme.done }]} />
        <Text style={[styles.linkText, { color: syncError ? theme.error : theme.done }]}>{syncError ? 'Sync lost' : 'SSH live'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ink },
  shell: { flex: 1, backgroundColor: colors.ink },
  body: { flex: 1, backgroundColor: colors.ink },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 40, backgroundColor: colors.ink },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingBadge: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  loadingMark: { fontSize: 27, fontWeight: '700' },
  connectedPage: { flex: 1, backgroundColor: colors.ink },
  connectedBody: { flex: 1 },
  topbar: { minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerBody: { flex: 1, minWidth: 0, paddingRight: 10 },
  topTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  topMeta: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  linkDot: { width: 6, height: 6, borderRadius: 3 },
  linkText: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  offline: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  offlineIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  offlineNumber: { fontSize: 28, fontWeight: '700' },
  offlineTitle: { fontSize: 21, lineHeight: 27, fontWeight: '600', marginTop: 18 },
  offlineCopy: { textAlign: 'center', fontSize: 15, lineHeight: 22, marginTop: 8, maxWidth: 330 },
  startServer: { minHeight: 44, borderRadius: 999, paddingHorizontal: 20, justifyContent: 'center', marginTop: 24 },
  startServerText: { fontSize: 14, fontWeight: '600' },
});

export default App;
