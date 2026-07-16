import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { AgentDetail } from './src/components/AgentDetail';
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
import { createRefreshCoordinator, type RefreshCoordinator } from './src/lib/refreshCoordinator';
import {
  applyLiveHostSnapshot,
  beginLiveHostSync,
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
  closeTerminalSession,
  openTerminalSession,
  updateTerminalSession,
  type TerminalSessionStatus,
} from './src/terminalSessions';
import { colors } from './src/theme';
import type { AgentInfo, AppTab, ConnectionProfile, HerdrSnapshot, HostProfile, PaneInfo } from './src/types';

interface LiveRuntime {
  client: HerdrClient;
  profile: ConnectionProfile;
  refresh: RefreshCoordinator<HerdrSnapshot>;
  previousStatuses: Map<string, string> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={colors.ink} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const runtimes = useRef(new Map<string, LiveRuntime>());
  const liveSessionsRef = useRef(emptyLiveHostSessions);
  const alertsEnabledRef = useRef(true);
  const ttsEnabledRef = useRef(false);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [editorProfile, setEditorProfile] = useState<ConnectionProfile | null>(null);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [liveSessions, setLiveSessions] = useState(emptyLiveHostSessions);
  const [navigation, setNavigation] = useState(initialMobileNavigation);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [terminalPreferences, setTerminalPreferences] = useState<TerminalPreferences>(defaultDevicePreferences.terminal);

  liveSessionsRef.current = liveSessions;
  alertsEnabledRef.current = alertsEnabled;
  ttsEnabledRef.current = ttsEnabled;

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

  useEffect(() => () => {
    for (const runtime of runtimes.current.values()) {
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      runtime.refresh.invalidate();
      runtime.client.disconnect();
    }
    runtimes.current.clear();
  }, []);

  const clearReconnect = (runtime: LiveRuntime) => {
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  };

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
              alertAgent(agent, ttsEnabledRef.current).catch(() => undefined);
            }
          }
        }
        runtime.previousStatuses = statuses;
        setLiveSessions(current => {
          const session = findLiveHostSession(current, sessionId);
          if (!session) return current;
          return applyLiveHostSnapshot(current, sessionId, session.sync.generation, snapshot, new Date().toISOString());
        });
      },
    );
    return runtime;
  };

  async function refreshHost(sessionId: string): Promise<void> {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) return;
    const result = await runtime.refresh.request();
    if (result.status === 'applied') {
      clearReconnect(runtime);
      runtime.reconnectAttempts = 0;
      setLiveSessions(current => updateLiveHostConnection(current, sessionId, { status: 'connected' }));
    } else if (result.status === 'failed') {
      setLiveSessions(current => {
        const session = findLiveHostSession(current, sessionId);
        if (!session) return current;
        return failLiveHostSync(current, sessionId, session.sync.generation, String(result.error));
      });
      scheduleReconnect(sessionId, result.error);
    }
  }

  const refreshAllOnTimer = useEffectEvent(() => {
    if (AppState.currentState !== 'active') return;
    for (const sessionId of runtimes.current.keys()) refreshHost(sessionId).catch(() => undefined);
  });

  useEffect(() => {
    if (liveSessions.sessions.length === 0) return;
    const timer = setInterval(refreshAllOnTimer, 2500);
    const subscription = AppState.addEventListener('change', state => state === 'active' && refreshAllOnTimer());
    return () => {
      clearInterval(timer);
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
      if (selectedAgentId) {
        setSelectedAgentId(null);
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
  }, [editorProfile, navigation, selectedAgentId, selectedPaneId]);

  const selectTab = (tab: AppTab) => setNavigation(current => selectMobileTab(current, tab));

  const closeLiveHost = useCallback((sessionId: string) => {
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    if (session) savePersistedTerminals(session.hostId, session.terminals).catch(() => undefined);
    const runtime = runtimes.current.get(sessionId);
    if (runtime) {
      clearReconnect(runtime);
      runtime.refresh.invalidate();
      runtime.client.disconnect();
      runtimes.current.delete(sessionId);
    }
    setSelectedAgentId(null);
    setSelectedPaneId(null);
    setLiveSessions(current => {
      const next = closeLiveHostSession(current, sessionId);
      if (next.sessions.length === 0) {
        setNavigation(nav => selectMobileTab(nav, 'hosts'));
      }
      return next;
    });
  }, []);

  const connect = async (nextProfile: ConnectionProfile) => {
    setConnecting(true);
    setConnectingHostId(nextProfile.id);
    setConnectError(null);
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === nextProfile.id);
    if (existing) closeLiveHost(existing.id);
    let runtime: LiveRuntime | null = null;
    try {
      const saved = await saveConnectionProfile(hosts, nextProfile);
      setHosts(saved.hosts);
      const sessionId = nextProfile.id;
      runtime = createRuntime(sessionId, nextProfile);
      runtimes.current.set(sessionId, runtime);
      setLiveSessions(current => openLiveHostSession(current, saved.host, sessionId));
      await runtime.client.connect(nextProfile);
      const initial = await runtime.client.snapshot();
      const restoredTerminals = await loadPersistedTerminals(nextProfile.id, initial);
      runtime.previousStatuses = new Map(initial.agents.map(agent => [agent.pane_id, agent.agent_status]));
      setLiveSessions(current => {
        let next = updateLiveHostConnection(current, sessionId, { status: 'connected' });
        const request = beginLiveHostSync(next, sessionId);
        next = applyLiveHostSnapshot(request.state, sessionId, request.generation, initial, new Date().toISOString());
        return replaceLiveHostTerminals(next, sessionId, restoredTerminals);
      });
      setEditorProfile(null);
      const usedHosts = await markHostConnected(saved.hosts, nextProfile.id);
      setHosts(usedHosts);
      setNavigation(current => selectMobileTab(current, 'herd'));
    } catch (error) {
      setConnectError(String(error));
      if (runtime) scheduleReconnect(nextProfile.id, error);
      setNavigation(current => selectMobileTab(current, 'hosts'));
    } finally {
      setConnecting(false);
      setConnectingHostId(null);
    }
  };

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
    setSelectedAgentId(null);
    setSelectedPaneId(null);
    setLiveSessions(current => selectLiveHostSession(current, sessionId));
    setNavigation(current => selectMobileTab(current, tab));
  }, []);

  const connectSavedHost = async (host: HostProfile) => {
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === host.id);
    if (existing) {
      selectLiveHost(existing.id, 'herd');
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

  const openPaneTerminal = (sessionId: string, pane: PaneInfo) => {
    setSelectedPaneId(null);
    activatePaneTerminal(sessionId, pane);
    selectLiveHost(sessionId, 'terminal');
  };

  const closeTerminal = useCallback((sessionId: string, terminalId: string) => {
    runtimes.current.get(sessionId)?.client.closeTerminal(terminalId);
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
  const selectedAgent = selectedAgentId && snapshot
    ? snapshot.agents.find(agent => agent.pane_id === selectedAgentId) || null
    : null;
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
    setSelectedAgentId(null);
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

  if (!profilesLoaded || !preferencesLoaded) {
    return <View style={styles.loading}><Text style={styles.loadingMark}>H/</Text></View>;
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
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.shell}>
        <View style={styles.body}>
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
              <View style={styles.connectedPage}>
                <ConnectedHeader session={activeSession} />
                <View style={styles.connectedBody}>
                  {!activeSession.snapshot.server.running ? (
                    <View style={styles.offline}>
                      <Text style={styles.offlineNumber}>00</Text>
                      <Text style={styles.offlineTitle}>HERDR SERVER IS OFFLINE</Text>
                      <Text style={styles.offlineCopy}>Start the headless runtime on the host, then manage the session from this client.</Text>
                      <Pressable disabled={activeSession.sync.status === 'syncing'} onPress={startServer} style={styles.startServer}>
                        <Text style={styles.startServerText}>{activeSession.sync.status === 'syncing' ? 'STARTING...' : 'START HERDR SERVER'}</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <HerdScreen
                      agents={activeSession.snapshot.agents}
                      refreshing={activeSession.sync.status === 'syncing'}
                      onRefresh={refreshActive}
                      onSelect={agent => setSelectedAgentId(agent.pane_id)}
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
          <View style={styles.overlay}>
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
          <View style={styles.overlay}>
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
        <>
          <AgentDetail
            agent={selectedAgent}
            client={activeClient}
            onClose={() => setSelectedAgentId(null)}
            onOpenTerminal={openAgentTerminal}
            onChanged={refreshActive}
          />
          <PaneDetail
            pane={selectedPane}
            client={activeClient}
            onClose={() => setSelectedPaneId(null)}
            onChanged={refreshActive}
            onOpenTerminal={pane => activeSession && openPaneTerminal(activeSession.id, pane)}
          />
        </>
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
  const syncError = session.sync.error || session.connectionError;
  return (
    <View style={styles.topbar}>
      <View style={styles.headerBody}>
        <Text numberOfLines={1} style={styles.topTitle}>{hostDisplayName(session.host).toUpperCase()} / HERD</Text>
        <Text numberOfLines={1} style={styles.topMeta}>{session.host.host} · {session.snapshot.server.running ? `v${session.snapshot.server.version || '?'}` : 'SERVER OFFLINE'}</Text>
      </View>
      <View style={[styles.link, syncError && styles.linkError]}>
        <View style={[styles.linkDot, syncError && styles.linkDotError]} />
        <Text style={[styles.linkText, syncError && styles.linkTextError]}>{syncError ? 'SYNC LOST' : 'SSH LIVE'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ink },
  shell: { flex: 1, backgroundColor: colors.ink },
  body: { flex: 1, backgroundColor: colors.ink },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 40, backgroundColor: colors.ink },
  loading: { flex: 1, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  loadingMark: { color: colors.acid, fontFamily: 'monospace', fontSize: 52, fontWeight: '900' },
  connectedPage: { flex: 1, backgroundColor: colors.ink },
  connectedBody: { flex: 1 },
  topbar: { height: 62, backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: 1, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerBody: { flex: 1, minWidth: 0, paddingRight: 10 },
  topTitle: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: 0.8 },
  topMeta: { color: colors.muted, fontFamily: 'monospace', fontSize: 8, marginTop: 4 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, borderColor: '#47552a', borderWidth: 1, paddingHorizontal: 8, paddingVertical: 5 },
  linkError: { borderColor: colors.blocked },
  linkDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.acid },
  linkDotError: { backgroundColor: colors.blocked },
  linkText: { color: colors.acid, fontFamily: 'monospace', fontSize: 8 },
  linkTextError: { color: colors.blocked },
  offline: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: colors.ink },
  offlineNumber: { color: colors.blocked, fontFamily: 'monospace', fontSize: 48, fontWeight: '900' },
  offlineTitle: { color: colors.text, fontFamily: 'monospace', fontSize: 16, fontWeight: '900', marginTop: 12 },
  offlineCopy: { color: colors.muted, textAlign: 'center', lineHeight: 20, marginTop: 9, maxWidth: 330 },
  startServer: { backgroundColor: colors.acid, paddingHorizontal: 20, paddingVertical: 13, marginTop: 22 },
  startServerText: { color: colors.ink, fontFamily: 'monospace', fontSize: 10, fontWeight: '900' },
});

export default App;
