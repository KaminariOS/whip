import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { TFunction } from 'i18next';
import type { HostRuntimeState } from 'react-native-whip-ssh';

import type { HostManagementController } from './useHostManagement';
import type { AppNavigationController } from './useAppNavigation';
import type { useAgentNotifications } from './useAgentNotifications';
import type { useApplicationSecurity } from './useApplicationSecurity';
import type { useLiveHostTelemetry } from './useLiveHostTelemetry';
import {
  useLiveHostMonitoring,
  type ReconnectRecoveryTrigger,
} from './useLiveHostMonitoring';
import type { useTerminalSessions } from './useTerminalSessions';
import type { LoadState } from './useStartupStorage';
import {
  applyNativeHostState,
  canRefreshLiveHostSession,
  closeLiveHostSession,
  emptyLiveHostSessions,
  findLiveHostSession,
  getActiveLiveHostSession,
  openLiveHostSession,
  preferredWorkspacePane,
  selectLiveHostSession,
  selectLiveHostWorkspaceView,
  updateLiveHostConnection,
  type LiveHostSessionsState,
} from '../liveHostSessions';
import {
  foregroundUsesBriefAlerts,
  isAgentAlertingStatus,
  previousVisibleAgentStatus,
  shouldNotifyAgentTransition,
  tabNameForAgent,
} from '../lib/agentStatusEvents';
import {
  requiresBiometricForKeyUse,
  requiresBiometricForSavedKey,
} from '../lib/biometricSecurity';
import {
  classifyConnectionError,
  connectionErrorContext,
  connectionErrorTranslationKeys,
} from '../lib/connectionErrors';
import { launchTabAndOpenCreatedTab } from '../lib/herdrCreationFlows';
import { hostDisplayName, resolveJumpHostChain } from '../lib/hostProfiles';
import { isHerdrProtocolMismatch } from '../lib/herdrProtocol';
import { shouldRefreshLiveHost } from '../lib/liveHostHeartbeat';
import {
  parseAgentNotificationTarget,
  resolveAgentNotificationTarget,
} from '../lib/notificationNavigation';
import { allSettledWithConcurrency } from '../lib/promisePool';
import {
  disposeRuntimeMap,
  savedHostConnectionAction,
  shouldRestartLiveSession,
  shouldRetainBackgroundRuntimes,
} from '../lib/sessionRuntimePolicy';
import {
  terminalRendererKey,
  type TerminalRenderTarget,
} from '../lib/terminalRenderer';
import { alertAgent, dismissAgentAlertsForPane } from '../services/alerts';
import { defaultDevicePreferences } from '../services/devicePreferences';
import {
  HerdrClient,
  type TabCreationResult,
  type TabLaunchIntent,
} from '../services/HerdrClient';
import {
  SLOW_HOST_LATENCY_MS,
  isSlowHostLatency,
  recordHostLatencyFailure,
  recordSlowHostLatency,
  type HostLatencyMeasurement,
} from '../services/latencyDiagnostics';
import {
  networkErrorKind,
  networkErrorMessage,
  recordNetworkDiagnostic,
} from '../services/networkDiagnostics';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  withAppPerformanceTrace,
  type AppPerformanceTrace,
} from '../services/performanceTrace';
import {
  loadPersistedLiveHosts,
  persistedLiveHostsFromSessions,
  persistedLiveHostsFromStorage,
  persistedLiveHostsIdentity,
  savePersistedLiveHosts,
  type PersistedLiveHosts,
} from '../services/persistedLiveHosts';
import {
  hydrateHerdrSocketPathCache,
  loadHerdrSocketPathCache,
} from '../services/herdrSocketPathStorage';
import { hostKeyErrorHost, parseUnknownHostKey } from '../services/knownHosts';
import {
  loadConnectionProfile,
  loadJumpHostConnectionProfiles,
} from '../services/hostProfiles';
import type { StartupStorageSnapshot } from '../services/startupStorage';
import { terminalSessionStatusFromNative } from '../terminalSessions';
import type {
  AgentInfo,
  AgentStatus,
  ConnectionProfile,
  HerdrSnapshot,
  HostProfile,
  PaneInfo,
} from '../types';

const BACKGROUND_HOST_RESTORE_CONCURRENCY = 2;

interface LiveRuntime {
  client: HerdrClient;
  profile: ConnectionProfile;
  previousStatuses: Map<string, AgentStatus> | null;
  latencyFailureActive: boolean;
  latencyDiagnosticFailureRecorded: boolean;
  latencyFailures: number;
  acceptHostState: (
    state: HostRuntimeState,
    changedAgentPaneIds?: string[],
  ) => void;
}

interface ConnectOptions {
  persistProfile?: boolean;
  navigate?: boolean;
  trackConnecting?: boolean;
  activateSession?: boolean;
  reuseConnectingSession?: boolean;
  biometricVerified?: boolean;
  promptForUnknownHosts?: boolean;
  traceStartupRestore?: boolean;
}

interface SessionRuntimeManagerOptions {
  startupStorage: LoadState<StartupStorageSnapshot>;
  deferredHydrationReady: boolean;
  preferencesLoaded: boolean;
  terminalHistoryLoaded: boolean;
  reopenTerminalOnLaunch: boolean;
  alertsEnabled: boolean;
  persistentAlertDurationSeconds: number;
  ttsEnabled: boolean;
  appAccessLocked: boolean;
  hostsVisible: boolean;
  t: TFunction;
  hosts: HostManagementController;
  navigation: AppNavigationController;
  security: ReturnType<typeof useApplicationSecurity>;
  notifications: ReturnType<typeof useAgentNotifications>;
  terminals: ReturnType<typeof useTerminalSessions>;
  telemetry: ReturnType<typeof useLiveHostTelemetry>;
}

export interface SessionRuntimeController {
  state: LiveHostSessionsState;
  activeSession: ReturnType<typeof getActiveLiveHostSession>;
  activeClient: HerdrClient | undefined;
  connectingHostIds: ReadonlySet<string>;
  restoreComplete: boolean;
  terminalTargets: TerminalRenderTarget[];
  getState: () => LiveHostSessionsState;
  getClient: (sessionId: string) => HerdrClient | undefined;
  select: (sessionId: string, tab?: 'herd' | 'terminal') => void;
  connect: (
    profile: ConnectionProfile,
    options?: ConnectOptions,
  ) => Promise<boolean>;
  connectSavedHost: (host: HostProfile) => Promise<void>;
  close: (sessionId: string, recordDisconnect?: boolean) => void;
  closeHostById: (hostId: string, recordDisconnect?: boolean) => void;
  refresh: (sessionId: string) => Promise<void>;
  refreshSnapshot: (sessionId: string) => Promise<HerdrSnapshot | null>;
  exitTerminalToHerd: (sessionId: string) => void;
  activatePaneTerminal: (sessionId: string, pane: PaneInfo) => void;
  openPaneTerminal: (
    sessionId: string,
    pane: PaneInfo,
    focusAgent?: boolean,
  ) => void;
  openAgentTerminal: (sessionId: string, agent: AgentInfo) => void;
  openSshShell: (sessionId: string) => void;
  closeTerminal: (sessionId: string, terminalId: string) => void;
  selectWorkspace: (sessionId: string, workspaceId: string) => void;
  focusWorkspace: (sessionId: string, workspaceId: string) => Promise<void>;
  openWorkspace: (sessionId: string, workspaceId: string) => Promise<void>;
  createWorkspace: (
    sessionId: string,
    name: string,
    cwd: string,
  ) => Promise<HerdrSnapshot['workspaces'][number]>;
  renameWorkspace: (
    sessionId: string,
    workspaceId: string,
    name: string,
  ) => Promise<void>;
  closeWorkspace: (sessionId: string, workspaceId: string) => Promise<void>;
  closeTab: (sessionId: string, tabId: string) => Promise<void>;
  launchTab: (
    sessionId: string,
    workspaceId: string,
    tabName: string,
    launch: TabLaunchIntent,
  ) => Promise<void>;
  startServer: (sessionId: string) => Promise<void>;
}

let retainedBackgroundRuntimes: Map<string, LiveRuntime> | null = null;

function withOptionalAppPerformanceTrace<Result>(
  enabled: boolean,
  name: string,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  return enabled
    ? withAppPerformanceTrace(name, operation)
    : Promise.resolve().then(operation);
}

function recordLatencyMeasurement(
  sessionId: string,
  measurement: HostLatencyMeasurement,
): void {
  if (!isSlowHostLatency(measurement)) return;
  recordNetworkDiagnostic('warn', 'latency-probe-slow', {
    sessionId,
    latencyMs: measurement.latencyMs,
    sshRttMs: measurement.sshRttMs,
    totalMs: measurement.totalMs,
    runtimeOverheadMs: measurement.runtimeOverheadMs,
  });
  recordSlowHostLatency(sessionId, measurement).catch(() => undefined);
}

/** Owns Rust runtime projections, live-session lifecycle, reconnect, and restore. */
export function useSessionRuntimeManager({
  startupStorage,
  deferredHydrationReady,
  preferencesLoaded,
  terminalHistoryLoaded,
  reopenTerminalOnLaunch,
  alertsEnabled,
  persistentAlertDurationSeconds,
  ttsEnabled,
  appAccessLocked,
  hostsVisible,
  t,
  hosts,
  navigation,
  security,
  notifications,
  terminals,
  telemetry,
}: SessionRuntimeManagerOptions): SessionRuntimeController {
  const [state, setState] = useState(emptyLiveHostSessions);
  const [connectingHostIds, setConnectingHostIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [persistedHostsLoaded, setPersistedHostsLoaded] = useState(false);
  const [socketPathsLoaded, setSocketPathsLoaded] = useState(false);
  const [safeToPersist, setSafeToPersist] = useState(false);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const stateRef = useRef(state);
  const runtimesRef = useRef(new Map<string, LiveRuntime>());
  const latencyPingsInFlightRef = useRef(new Map<string, LiveRuntime>());
  const persistedHostsRef = useRef<PersistedLiveHosts>({
    hostIds: [],
    activeHostId: null,
  });
  const restoredTerminalHostIdsRef = useRef(new Set<string>());
  const deferredHydrationStartedRef = useRef(false);
  const restoreStartedRef = useRef(false);
  const alertsEnabledRef = useRef(alertsEnabled);
  const persistentAlertDurationSecondsRef = useRef(
    defaultDevicePreferences.persistentAlertDurationSeconds,
  );
  const ttsEnabledRef = useRef(ttsEnabled);
  const latencyStateApplyTracesRef = useRef(new Set<AppPerformanceTrace>());
  stateRef.current = state;
  alertsEnabledRef.current = alertsEnabled;
  persistentAlertDurationSecondsRef.current = persistentAlertDurationSeconds;
  ttsEnabledRef.current = ttsEnabled;
  const { clearLatency, recordLatency } = telemetry;

  const getState = useCallback(() => stateRef.current, []);
  const getClient = useCallback(
    (sessionId: string) => runtimesRef.current.get(sessionId)?.client,
    [],
  );

  useEffect(() => {
    for (const trace of latencyStateApplyTracesRef.current) {
      endAppPerformanceTrace(trace);
    }
    latencyStateApplyTracesRef.current.clear();
  }, [telemetry.state]);

  useEffect(() => {
    const retained = retainedBackgroundRuntimes;
    if (!retained) return;
    retainedBackgroundRuntimes = null;
    disposeRuntimeMap(retained);
  }, []);

  useEffect(
    () => () => {
      for (const trace of latencyStateApplyTracesRef.current) {
        endAppPerformanceTrace(trace);
      }
      latencyStateApplyTracesRef.current.clear();
      if (
        shouldRetainBackgroundRuntimes(
          Platform.OS,
          alertsEnabledRef.current,
          stateRef.current.sessions.length,
        )
      ) {
        retainedBackgroundRuntimes = runtimesRef.current;
        return;
      }
      disposeRuntimeMap(runtimesRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!deferredHydrationReady || deferredHydrationStartedRef.current) return;
    deferredHydrationStartedRef.current = true;
    const snapshot =
      startupStorage.status === 'loaded' ? startupStorage.value : null;
    const liveHostsLoad = snapshot
      ? persistedLiveHostsFromStorage(snapshot.liveHosts)
      : loadPersistedLiveHosts();
    withAppPerformanceTrace(
      'Whip startup store: live hosts',
      () => liveHostsLoad,
    )
      .then(value => {
        persistedHostsRef.current = value;
        setSafeToPersist(true);
      })
      .catch(() => {
        persistedHostsRef.current = { hostIds: [], activeHostId: null };
        setSafeToPersist(false);
      })
      .finally(() => setPersistedHostsLoaded(true));
    withAppPerformanceTrace('Whip startup store: socket paths', () =>
      snapshot
        ? hydrateHerdrSocketPathCache(snapshot.herdrSocketPaths)
        : loadHerdrSocketPathCache(),
    )
      .catch(() => undefined)
      .finally(() => setSocketPathsLoaded(true));
  }, [deferredHydrationReady, startupStorage]);

  const persistedSelection = persistedLiveHostsFromSessions(state);
  const persistedIdentity = persistedLiveHostsIdentity(persistedSelection);
  const persistSelection = useEffectEvent(() => {
    savePersistedLiveHosts(
      persistedLiveHostsFromSessions(stateRef.current),
    ).catch(() => undefined);
  });
  useEffect(() => {
    if (!restoreComplete || !safeToPersist) return;
    persistSelection();
  }, [persistedIdentity, restoreComplete, safeToPersist]);

  const trackHostConnection = useCallback(
    (hostId: string, connecting: boolean) => {
      setConnectingHostIds(current => {
        if (current.has(hostId) === connecting) return current;
        const next = new Set(current);
        if (connecting) next.add(hostId);
        else next.delete(hostId);
        return next;
      });
    },
    [],
  );

  const scheduleEventReconnect = useCallback(
    (sessionId: string, cause: unknown) => {
      if (!runtimesRef.current.has(sessionId)) return;
      recordNetworkDiagnostic('warn', 'event-stream-recovery-native', {
        sessionId,
        cause: networkErrorMessage(cause),
      });
    },
    [],
  );

  const scheduleReconnect = useCallback(
    (sessionId: string, cause: unknown) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) return;
      const session = findLiveHostSession(stateRef.current, sessionId);
      if (session?.status === 'connected' || session?.status === 'ready') {
        hosts.markDisconnected(session.hostId);
      }
      if (isHerdrProtocolMismatch(cause)) {
        clearLatency(sessionId);
        recordNetworkDiagnostic(
          'error',
          'control-reconnect-protocol-mismatch',
          {
            sessionId,
            error: networkErrorMessage(cause),
          },
        );
        setState(current =>
          updateLiveHostConnection(current, sessionId, {
            status: 'error',
            error: String(cause),
          }),
        );
        return;
      }
      recordNetworkDiagnostic('warn', 'control-recovery-requested', {
        sessionId,
        cause: networkErrorMessage(cause),
      });
      clearLatency(sessionId);
      setState(current =>
        updateLiveHostConnection(current, sessionId, {
          status: 'reconnecting',
          error: String(cause),
        }),
      );
      runtime.client.reconnectControl(runtime.profile).catch(reconnectError => {
        if (runtimesRef.current.get(sessionId) !== runtime) return;
        recordNetworkDiagnostic('warn', 'control-recovery-native-failed', {
          sessionId,
          error: networkErrorMessage(reconnectError),
        });
      });
    },
    [clearLatency, hosts],
  );

  const createRuntime = useCallback(
    (sessionId: string, profile: ConnectionProfile): LiveRuntime => {
      const runtime = {
        client: new HerdrClient(),
        profile,
        previousStatuses: null,
        latencyFailureActive: false,
        latencyDiagnosticFailureRecorded: false,
        latencyFailures: 0,
      } as LiveRuntime;
      const acceptHostState = (
        hostState: HostRuntimeState,
        changedAgentPaneIds: string[] = [],
      ) => {
        if (runtimesRef.current.get(sessionId) !== runtime) return;
        const snapshot = runtime.client.snapshotFromHostState(hostState);
        const visibleSnapshot = findLiveHostSession(
          stateRef.current,
          sessionId,
        )?.snapshot;
        const statuses = new Map(
          snapshot.agents.map(agent => [agent.pane_id, agent.agent_status]),
        );
        const changed = new Set(changedAgentPaneIds);
        if (runtime.previousStatuses) {
          for (const agent of snapshot.agents) {
            if (
              runtime.previousStatuses.get(agent.pane_id) !== agent.agent_status
            ) {
              changed.add(agent.pane_id);
            }
          }
        }
        for (const paneId of changed) {
          const agent = snapshot.agents.find(item => item.pane_id === paneId);
          const status =
            agent?.agent_status ??
            snapshot.panes.find(item => item.pane_id === paneId)?.agent_status;
          if (!status) continue;
          const previous = previousVisibleAgentStatus(
            visibleSnapshot,
            paneId,
            runtime.previousStatuses?.get(paneId),
          );
          if (!isAgentAlertingStatus(status)) {
            dismissAgentAlertsForPane(sessionId, paneId).catch(() => undefined);
          }
          if (
            agent &&
            alertsEnabledRef.current &&
            shouldNotifyAgentTransition(previous, status)
          ) {
            const brief = foregroundUsesBriefAlerts(
              AppState.currentState === 'active',
            );
            alertAgent(
              agent,
              ttsEnabledRef.current,
              { hostId: sessionId, paneId },
              tabNameForAgent(agent, snapshot.tabs),
              brief ? 'brief' : 'persistent',
              persistentAlertDurationSecondsRef.current * 1_000,
            ).catch(() => undefined);
          }
          recordNetworkDiagnostic('info', 'agent-status-state-change', {
            sessionId,
            paneId,
            status,
            revision: hostState.revision,
          });
        }
        runtime.previousStatuses = statuses;
        startTransition(() => {
          setState(current =>
            applyNativeHostState(current, sessionId, hostState, snapshot),
          );
          terminals.reconcile(sessionId, snapshot.panes);
        });
        if (
          hostState.freshness === 'fresh' ||
          hostState.freshness === 'unavailable'
        ) {
          hosts.setError(null);
          setState(current =>
            updateLiveHostConnection(current, sessionId, { status: 'ready' }),
          );
        }
      };
      runtime.client.setRuntimeEventHandler(event => {
        const initialConnectDiagnostic =
          event.type === 'diagnostic' &&
          event.diagnostic.operation === 'ssh-connect';
        if (
          runtimesRef.current.get(sessionId) !== runtime &&
          !initialConnectDiagnostic
        )
          return;
        if (event.type === 'diagnostic') {
          const diagnostic = event.diagnostic;
          recordNetworkDiagnostic(
            diagnostic.outcome === 'failed'
              ? 'error'
              : diagnostic.durationMs >= SLOW_HOST_LATENCY_MS
              ? 'warn'
              : 'info',
            'native-runtime-diagnostic',
            {
              sessionId,
              operation: diagnostic.operation,
              outcome: diagnostic.outcome,
              durationMs: Math.round(diagnostic.durationMs * 10) / 10,
              transportDurationMs:
                diagnostic.transportDurationMs === undefined
                  ? undefined
                  : Math.round(diagnostic.transportDurationMs * 10) / 10,
              terminalId: diagnostic.terminalId,
              error: diagnostic.error,
            },
          );
          if (
            diagnostic.operation === 'host-latency-probe' &&
            diagnostic.outcome === 'failed'
          ) {
            if (!runtime.latencyDiagnosticFailureRecorded) {
              runtime.latencyDiagnosticFailureRecorded = true;
              recordHostLatencyFailure(
                sessionId,
                diagnostic.durationMs,
                diagnostic.error || 'Host latency probe failed',
              ).catch(() => undefined);
            }
          }
          return;
        }
        if (event.type === 'connection-state') {
          recordNetworkDiagnostic(
            event.state === 'failed' ? 'error' : 'info',
            'native-connection-state',
            {
              sessionId,
              state: event.state,
              reconnectAttempt: event.reconnectAttempt,
              error: event.error,
            },
          );
          if (event.state === 'reconnecting' || event.state === 'connecting') {
            setState(current =>
              updateLiveHostConnection(current, sessionId, {
                status: 'reconnecting',
                error: event.error,
                reconnectAttempt: event.reconnectAttempt,
              }),
            );
          } else if (event.state === 'failed') {
            setState(current =>
              updateLiveHostConnection(current, sessionId, {
                status: 'error',
                error: event.error,
                reconnectAttempt: event.reconnectAttempt,
              }),
            );
          }
          return;
        }
        if (event.type === 'reconnect-scheduled') {
          recordNetworkDiagnostic('warn', 'control-reconnect-scheduled', {
            sessionId,
            attempt: event.attempt,
            delayMs: event.delayMs,
            reason: event.reason,
          });
          return;
        }
        if (event.type === 'reconnected') {
          runtime.latencyFailures = 0;
          runtime.latencyFailureActive = false;
          runtime.latencyDiagnosticFailureRecorded = false;
          recordNetworkDiagnostic('info', 'control-reconnect-recovered', {
            sessionId,
            generation: event.generation,
            restoredTerminals: event.restoredTerminals,
          });
          return;
        }
        if (event.type === 'host-state') {
          acceptHostState(event.state, event.changedAgentPaneIds);
          return;
        }
        if (event.type === 'terminal-state') {
          terminals.updateStatus(
            sessionId,
            event.terminalId,
            terminalSessionStatusFromNative(event.state, event.retrying),
            event.error,
            event.reconnectAttempt,
          );
          if (event.state === 'failed' && !event.retrying) {
            recordNetworkDiagnostic('error', 'terminal-recovery-exhausted', {
              sessionId,
              terminalId: event.terminalId,
              error: event.error,
            });
          }
          return;
        }
        if (event.type === 'event-stream-closed') {
          scheduleEventReconnect(sessionId, event.reason);
          return;
        }
        if (event.type === 'event-stream-restored') {
          recordNetworkDiagnostic('info', 'event-stream-restored-native', {
            sessionId,
            generation: event.generation,
          });
          return;
        }
        if (event.type === 'fatal-error') {
          setState(current =>
            updateLiveHostConnection(current, sessionId, {
              status: 'error',
              error: event.message,
            }),
          );
        }
      });
      runtime.acceptHostState = acceptHostState;
      return runtime;
    },
    [hosts, scheduleEventReconnect, terminals],
  );

  const close = useCallback(
    (sessionId: string, recordDisconnect = true) => {
      const session = findLiveHostSession(stateRef.current, sessionId);
      if (session && recordDisconnect) hosts.markDisconnected(session.hostId);
      terminals.remove(sessionId);
      const runtime = runtimesRef.current.get(sessionId);
      if (runtime) {
        runtime.client
          .releaseAllTerminals()
          .finally(() => runtime.client.disconnect());
        runtimesRef.current.delete(sessionId);
      }
      clearLatency(sessionId);
      navigation.clearSessionView(sessionId);
      setState(current => {
        const next = closeLiveHostSession(current, sessionId);
        if (next.sessions.length === 0) navigation.selectTab('hosts');
        return next;
      });
    },
    [clearLatency, hosts, navigation, terminals],
  );

  const closeHostById = useCallback(
    (hostId: string, recordDisconnect = true) => {
      const session = stateRef.current.sessions.find(
        item => item.hostId === hostId,
      );
      if (session) close(session.id, recordDisconnect);
    },
    [close],
  );

  const refreshSnapshot = useCallback(
    async (sessionId: string): Promise<HerdrSnapshot | null> => {
      const runtime = runtimesRef.current.get(sessionId);
      const session = findLiveHostSession(stateRef.current, sessionId);
      if (!runtime || !canRefreshLiveHostSession(session)) return null;
      const trace = beginAppPerformanceTrace('Whip host snapshot refresh');
      try {
        const hostState = await runtime.client.refreshHostState();
        const snapshot = runtime.client.snapshotFromHostState(hostState);
        if (hostState.syncStatus === 'error') {
          recordNetworkDiagnostic('error', 'snapshot-refresh-failed', {
            sessionId,
            connectionStatus: session.status,
            freshness: hostState.freshness,
            error: hostState.error,
          });
          return null;
        }
        return snapshot;
      } finally {
        endAppPerformanceTrace(trace);
      }
    },
    [],
  );

  const refresh = useCallback(
    async (sessionId: string) => {
      await refreshSnapshot(sessionId);
    },
    [refreshSnapshot],
  );

  const resumeConnections = useCallback(
    (reconcile = false) => {
      for (const session of stateRef.current.sessions) {
        if (
          runtimesRef.current.has(session.id) &&
          shouldRefreshLiveHost(session, reconcile)
        ) {
          refresh(session.id).catch(() => undefined);
        }
      }
    },
    [refresh],
  );

  const restartConnections = useCallback(
    (trigger: ReconnectRecoveryTrigger) => {
      for (const session of stateRef.current.sessions) {
        if (!runtimesRef.current.has(session.id)) continue;
        if (!shouldRestartLiveSession(trigger, session.status)) continue;
        scheduleReconnect(
          session.id,
          trigger === 'network-change'
            ? t('app.networkChangedReconnect')
            : session.connectionError || t('app.resumeReconnect'),
        );
      }
    },
    [scheduleReconnect, t],
  );

  const probeLiveHost = useCallback(
    (sessionId: string) => {
      if (AppState.currentState !== 'active') return;
      const session = findLiveHostSession(stateRef.current, sessionId);
      if (session?.status !== 'ready') return;
      const runtime = runtimesRef.current.get(sessionId);
      if (
        !runtime ||
        latencyPingsInFlightRef.current.get(sessionId) === runtime
      )
        return;
      latencyPingsInFlightRef.current.set(sessionId, runtime);
      runtime.client
        .measureLatency()
        .then(measurement => {
          if (runtimesRef.current.get(sessionId) !== runtime) return;
          runtime.latencyFailures = 0;
          runtime.latencyDiagnosticFailureRecorded = false;
          if (runtime.latencyFailureActive) {
            runtime.latencyFailureActive = false;
            recordNetworkDiagnostic('info', 'latency-probe-recovered', {
              sessionId,
              latencyMs: measurement.latencyMs,
            });
          }
          const trace = beginAppPerformanceTrace(
            'Whip host latency state apply',
          );
          startTransition(() => {
            const changed = recordLatency(sessionId, measurement.latencyMs);
            if (trace && changed) latencyStateApplyTracesRef.current.add(trace);
            else endAppPerformanceTrace(trace);
          });
          recordLatencyMeasurement(sessionId, measurement);
        })
        .catch(probeError => {
          if (runtimesRef.current.get(sessionId) !== runtime) return;
          runtime.latencyFailures += 1;
          clearLatency(sessionId);
          if (!runtime.latencyFailureActive) {
            runtime.latencyFailureActive = true;
            recordNetworkDiagnostic('warn', 'latency-probe-failed', {
              sessionId,
              failures: runtime.latencyFailures,
              error: networkErrorMessage(probeError),
            });
          }
        })
        .finally(() => {
          if (latencyPingsInFlightRef.current.get(sessionId) === runtime) {
            latencyPingsInFlightRef.current.delete(sessionId);
          }
        });
    },
    [clearLatency, recordLatency],
  );

  const measureLatencies = useCallback(() => {
    for (const session of stateRef.current.sessions) {
      if (session.status === 'ready') {
        probeLiveHost(session.id);
      }
    }
  }, [probeLiveHost]);

  useLiveHostMonitoring({
    liveHostCount: state.sessions.length,
    alertsEnabled,
    restoreComplete,
    hostsVisible,
    appAccessLocked,
    restartConnections,
    measureLatencies,
    resumeConnections,
    onBackgroundMonitoringError: monitoringError => {
      hosts.setError(
        t('app.backgroundUnavailable', { error: String(monitoringError) }),
      );
    },
  });

  const connect = useCallback(
    async (
      nextProfile: ConnectionProfile,
      options: ConnectOptions = {},
    ): Promise<boolean> => {
      const {
        persistProfile = true,
        navigate = true,
        trackConnecting = true,
        activateSession = true,
        reuseConnectingSession = false,
        biometricVerified = false,
        promptForUnknownHosts = navigate,
        traceStartupRestore = false,
      } = options;
      if (trackConnecting) trackHostConnection(nextProfile.id, true);
      hosts.setError(null);
      const existing = stateRef.current.sessions.find(
        session => session.hostId === nextProfile.id,
      );
      const reusingConnectingSession = Boolean(
        reuseConnectingSession &&
          existing &&
          !runtimesRef.current.has(existing.id),
      );
      if (existing && !reusingConnectingSession) close(existing.id);
      let runtime: LiveRuntime | null = null;
      let liveSessionOpened = false;
      let connectionStage = 'prepare';
      recordNetworkDiagnostic('info', 'host-connect-requested', {
        sessionId: nextProfile.id,
        endpoint: nextProfile.host.trim(),
        port: Number(nextProfile.port),
        authMode: nextProfile.authMode,
        reuseConnectingSession,
        startupRestore: traceStartupRestore,
      });
      try {
        connectionStage = 'jump-credentials';
        const jumpProfiles = await withOptionalAppPerformanceTrace(
          traceStartupRestore,
          'Whip startup restore: jump credentials',
          () => loadJumpHostConnectionProfiles(hosts.getHosts(), nextProfile),
        );
        const jumpWithoutCredential = jumpProfiles.find(
          profile => !profile.secret,
        );
        if (jumpWithoutCredential) {
          throw new Error(
            `${hostDisplayName(
              jumpWithoutCredential,
            )} needs a saved SSH credential before it can be used as a jump host`,
          );
        }
        const protectedConnection = [nextProfile, ...jumpProfiles].some(
          profile =>
            requiresBiometricForKeyUse(
              profile,
              security.isKeyProtectionEnabled(),
            ),
        );
        if (
          !biometricVerified &&
          protectedConnection &&
          !(await security.verifyBiometric())
        )
          return false;
        const saved = persistProfile
          ? await hosts.persistProfile(nextProfile)
          : {
              hosts: hosts.getHosts(),
              host: hosts.getHosts().find(host => host.id === nextProfile.id),
            };
        if (!saved.host) {
          throw new Error(`Saved host ${nextProfile.id} no longer exists`);
        }
        const sessionId = nextProfile.id;
        runtime = createRuntime(sessionId, nextProfile);
        let trustedKeys = 0;
        while (true) {
          try {
            connectionStage = 'native-ssh-connect';
            await withOptionalAppPerformanceTrace(
              traceStartupRestore,
              'Whip startup restore: SSH connect',
              () => runtime!.client.connect(nextProfile, jumpProfiles),
            );
            break;
          } catch (connectError) {
            const challenge = parseUnknownHostKey(connectError);
            if (!challenge || !promptForUnknownHosts) throw connectError;
            if (trustedKeys >= jumpProfiles.length + 1) throw connectError;
            if (!(await hosts.confirmUnknownHost(challenge))) {
              throw new Error(t('knownHosts.notTrusted'));
            }
            await hosts.trustChallenge(challenge);
            trustedKeys += 1;
          }
        }
        connectionStage = 'initial-host-state';
        const initialState = runtime.client.hostState();
        const initial = runtime.client.snapshotFromHostState(initialState);
        connectionStage = 'terminal-restore';
        const restoredTerminals = await withOptionalAppPerformanceTrace(
          traceStartupRestore,
          'Whip startup restore: terminal state',
          () => terminals.restore(sessionId, nextProfile.id, initial),
        );
        if (restoredTerminals.activeTerminalId) {
          restoredTerminalHostIdsRef.current.add(nextProfile.id);
        }
        runtime.previousStatuses = new Map(
          initial.agents.map(agent => [agent.pane_id, agent.agent_status]),
        );
        runtimesRef.current.set(sessionId, runtime);
        setState(current => {
          let next = openLiveHostSession(
            current,
            saved.host!,
            sessionId,
            activateSession,
          );
          next = updateLiveHostConnection(next, sessionId, { status: 'ready' });
          return applyNativeHostState(next, sessionId, initialState, initial);
        });
        liveSessionOpened = true;
        recordNetworkDiagnostic('info', 'host-connect-ready', {
          sessionId,
          endpoint: nextProfile.host.trim(),
          paneCount: initial.panes.length,
          serverRunning: initial.server.running,
        });
        hosts.closeEditor();
        if (navigate) {
          if (initial.server.running) navigation.showTerminal(sessionId);
          else navigation.showHerd(sessionId);
        }
        return true;
      } catch (connectError) {
        recordNetworkDiagnostic('error', 'host-connect-failed', {
          sessionId: nextProfile.id,
          endpoint: nextProfile.host.trim(),
          stage: connectionStage,
          errorKind: networkErrorKind(connectError),
          error: networkErrorMessage(connectError),
        });
        const message = t(
          connectionErrorTranslationKeys[classifyConnectionError(connectError)],
          {
            host:
              hostKeyErrorHost(connectError) || hostDisplayName(nextProfile),
            ...connectionErrorContext(connectError),
          },
        );
        hosts.setError(message);
        if (reuseConnectingSession) {
          setState(current =>
            updateLiveHostConnection(current, nextProfile.id, {
              status: 'error',
              error: message,
            }),
          );
        }
        if (runtime) {
          if (liveSessionOpened)
            scheduleReconnect(nextProfile.id, connectError);
          else runtime.client.disconnect();
        }
        if (navigate) navigation.selectTab('hosts');
        return false;
      } finally {
        if (trackConnecting) trackHostConnection(nextProfile.id, false);
      }
    },
    [
      close,
      createRuntime,
      hosts,
      navigation,
      scheduleReconnect,
      security,
      t,
      terminals,
      trackHostConnection,
    ],
  );

  const restorePersistedHosts = useEffectEvent(async () => {
    const trace = beginAppPerformanceTrace('Whip startup restore live hosts');
    try {
      const persisted = persistedHostsRef.current;
      const persistedHosts = persisted.hostIds
        .map(hostId => hosts.getHosts().find(item => item.id === hostId))
        .filter((host): host is HostProfile => Boolean(host));
      setState(current => {
        let next = current;
        for (const host of persistedHosts) {
          next = openLiveHostSession(next, host, host.id, false);
        }
        return persisted.activeHostId
          ? selectLiveHostSession(next, persisted.activeHostId)
          : next;
      });
      const hasProtectedKey = persistedHosts.some(host => {
        try {
          return [host, ...resolveJumpHostChain(hosts.getHosts(), host)].some(
            candidate =>
              requiresBiometricForSavedKey(
                candidate,
                security.isKeyProtectionEnabled(),
              ),
          );
        } catch {
          return requiresBiometricForSavedKey(
            host,
            security.isKeyProtectionEnabled(),
          );
        }
      });
      const protectedKeyAccessGranted =
        !hasProtectedKey ||
        (await withAppPerformanceTrace(
          'Whip startup restore: biometric',
          security.verifyBiometric,
        ));
      const restoreHost = async (hostId: string) => {
        const host = hosts.getHosts().find(item => item.id === hostId);
        if (!host) return;
        let protectedKey = requiresBiometricForSavedKey(
          host,
          security.isKeyProtectionEnabled(),
        );
        try {
          protectedKey = [
            host,
            ...resolveJumpHostChain(hosts.getHosts(), host),
          ].some(candidate =>
            requiresBiometricForSavedKey(
              candidate,
              security.isKeyProtectionEnabled(),
            ),
          );
        } catch {
          // The connect path reports missing or cyclic jump-host configuration.
        }
        if (protectedKey && !protectedKeyAccessGranted) {
          setState(current => closeLiveHostSession(current, hostId));
          return;
        }
        try {
          const profile = await withAppPerformanceTrace(
            'Whip startup restore: credentials',
            () => loadConnectionProfile(host),
          );
          if (!profile.secret) {
            throw new Error('Saved SSH credential is unavailable');
          }
          await connect(profile, {
            persistProfile: false,
            navigate: false,
            trackConnecting: false,
            activateSession: hostId === persisted.activeHostId,
            reuseConnectingSession: true,
            biometricVerified: protectedKey,
            traceStartupRestore: true,
          });
        } catch (restoreError) {
          const message = t('app.restoreHostError', {
            host: hostDisplayName(host),
            error: String(restoreError),
          });
          hosts.setError(message);
          setState(current =>
            updateLiveHostConnection(current, hostId, {
              status: 'error',
              error: message,
            }),
          );
        }
      };
      const validHostIds = persistedHosts.map(host => host.id);
      const activeHostId =
        persisted.activeHostId && validHostIds.includes(persisted.activeHostId)
          ? persisted.activeHostId
          : null;
      let activeTerminalReopened = false;
      if (activeHostId) {
        await withAppPerformanceTrace('Whip startup restore: active host', () =>
          restoreHost(activeHostId),
        );
        setState(current => selectLiveHostSession(current, activeHostId));
        if (
          reopenTerminalOnLaunch &&
          restoredTerminalHostIdsRef.current.has(activeHostId)
        ) {
          navigation.showTerminal(activeHostId);
          activeTerminalReopened = true;
        }
      }
      const backgroundHostIds = validHostIds.filter(id => id !== activeHostId);
      await withAppPerformanceTrace(
        'Whip startup restore: background hosts',
        () =>
          allSettledWithConcurrency(
            backgroundHostIds,
            BACKGROUND_HOST_RESTORE_CONCURRENCY,
            restoreHost,
          ),
      );
      if (persisted.activeHostId) {
        setState(current => {
          const active = current.sessions.find(
            session => session.hostId === persisted.activeHostId,
          );
          return active ? selectLiveHostSession(current, active.id) : current;
        });
      }
      if (reopenTerminalOnLaunch && !activeTerminalReopened) {
        const terminalHostId =
          (persisted.activeHostId &&
          restoredTerminalHostIdsRef.current.has(persisted.activeHostId)
            ? persisted.activeHostId
            : undefined) ??
          [...persisted.hostIds]
            .reverse()
            .find(hostId => restoredTerminalHostIdsRef.current.has(hostId));
        if (terminalHostId) {
          setState(current => {
            const terminalHost = current.sessions.find(
              session => session.hostId === terminalHostId,
            );
            return terminalHost
              ? selectLiveHostSession(current, terminalHost.id)
              : current;
          });
          navigation.showTerminal(terminalHostId);
        }
      }
      setRestoreComplete(true);
      hosts.completeLiveHostRestore();
    } finally {
      endAppPerformanceTrace(trace);
    }
  });

  useEffect(() => {
    if (
      !hosts.profilesLoaded ||
      !preferencesLoaded ||
      !terminalHistoryLoaded ||
      !persistedHostsLoaded ||
      !socketPathsLoaded ||
      !hosts.knownHostsLoaded ||
      restoreStartedRef.current
    )
      return;
    restoreStartedRef.current = true;
    restorePersistedHosts().catch(restoreError => {
      hosts.setError(
        t('app.restoreLiveHostsError', { error: String(restoreError) }),
      );
      setRestoreComplete(true);
      hosts.completeLiveHostRestore();
    });
  }, [
    hosts.knownHostsLoaded,
    hosts.profilesLoaded,
    hosts,
    persistedHostsLoaded,
    preferencesLoaded,
    socketPathsLoaded,
    terminalHistoryLoaded,
    t,
  ]);

  const select = useCallback(
    (sessionId: string, tab: 'herd' | 'terminal' = 'terminal') => {
      navigation.selectPane(null);
      setState(current => selectLiveHostSession(current, sessionId));
      if (tab === 'terminal') navigation.showTerminal(sessionId);
      else navigation.showHerd(sessionId);
    },
    [navigation],
  );

  const connectSavedHost = useCallback(
    async (host: HostProfile) => {
      const existing = stateRef.current.sessions.find(
        session => session.hostId === host.id,
      );
      const existingRuntime = existing
        ? runtimesRef.current.get(existing.id)
        : undefined;
      const action = savedHostConnectionAction(
        existing?.status,
        Boolean(existingRuntime),
      );
      if (existing && action === 'select') {
        select(existing.id, 'terminal');
        refresh(existing.id).catch(error =>
          scheduleReconnect(existing.id, error),
        );
        return;
      }
      if (existing && action === 'wait') {
        select(existing.id, 'terminal');
        return;
      }
      hosts.setError(null);
      trackHostConnection(host.id, true);
      try {
        const profile = await hosts.loadProfileForConnection(host);
        if (!profile) return;
        await connect(profile, {
          persistProfile: false,
          trackConnecting: false,
          reuseConnectingSession: Boolean(existing),
        });
      } catch (connectError) {
        hosts.setError(String(connectError));
      } finally {
        trackHostConnection(host.id, false);
      }
    },
    [connect, hosts, refresh, scheduleReconnect, select, trackHostConnection],
  );

  const exitTerminalToHerd = useCallback(
    (sessionId: string) => {
      const session = findLiveHostSession(stateRef.current, sessionId);
      const activeTerminalId = terminals.get(sessionId).activeTerminalId;
      const pane = session?.snapshot.panes.find(
        item => item.terminal_id === activeTerminalId,
      );
      navigation.showHerd(
        sessionId,
        pane?.workspace_id || session?.selection.workspaceId,
      );
    },
    [navigation, terminals],
  );

  const activatePaneTerminal = useCallback(
    (sessionId: string, pane: PaneInfo) => terminals.openPane(sessionId, pane),
    [terminals],
  );

  const openPaneTerminal = useCallback(
    (sessionId: string, pane: PaneInfo, focusAgent = false) => {
      navigation.selectPane(null);
      terminals.openPane(sessionId, pane);
      select(sessionId, 'terminal');
      const runtime = runtimesRef.current.get(sessionId);
      const focus = focusAgent
        ? runtime?.client.focusAgent(pane.pane_id)
        : runtime?.client.focusPane(pane.pane_id);
      focus?.catch(error => scheduleReconnect(sessionId, error));
    },
    [navigation, scheduleReconnect, select, terminals],
  );

  const openAgentTerminal = useCallback(
    (sessionId: string, agent: AgentInfo) => {
      const pane = findLiveHostSession(
        stateRef.current,
        sessionId,
      )?.snapshot.panes.find(item => item.pane_id === agent.pane_id);
      if (pane) openPaneTerminal(sessionId, pane, true);
    },
    [openPaneTerminal],
  );

  const openSshShell = useCallback(
    (sessionId: string) => {
      navigation.selectPane(null);
      terminals.openSshShell(sessionId, t('terminal.sshShell'));
      select(sessionId, 'terminal');
    },
    [navigation, select, t, terminals],
  );

  const openNotificationTarget = useEffectEvent(() => {
    if (!notifications.response) return false;
    const target = parseAgentNotificationTarget(
      notifications.response,
      Notifications.DEFAULT_ACTION_IDENTIFIER,
    );
    if (!target || notifications.wasHandled(target.notificationId))
      return false;
    const resolved = resolveAgentNotificationTarget(stateRef.current, target);
    if (!resolved) return false;
    hosts.closeEditor();
    hosts.setError(null);
    openPaneTerminal(resolved.sessionId, resolved.pane, true);
    notifications.consume(target.notificationId);
    return true;
  });
  useEffect(() => {
    if (!restoreComplete || !notifications.response) return;
    openNotificationTarget();
  }, [notifications.response, restoreComplete]);

  const closeTerminal = useCallback(
    (sessionId: string, terminalId: string) => {
      runtimesRef.current
        .get(sessionId)
        ?.client.closeTerminalBridge(terminalId)
        .catch(() => undefined);
      terminals.close(sessionId, terminalId);
    },
    [terminals],
  );

  const selectWorkspace = useCallback(
    (sessionId: string, workspaceId: string) => {
      setState(current =>
        selectLiveHostWorkspaceView(current, sessionId, workspaceId),
      );
    },
    [],
  );

  const requireRuntime = useCallback(
    (sessionId: string) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
      return runtime;
    },
    [t],
  );

  const focusWorkspace = useCallback(
    async (sessionId: string, workspaceId: string) => {
      await requireRuntime(sessionId).client.focusWorkspace(workspaceId);
    },
    [requireRuntime],
  );

  const openWorkspace = useCallback(
    async (sessionId: string, workspaceId: string) => {
      const runtime = requireRuntime(sessionId);
      const snapshot = findLiveHostSession(
        stateRef.current,
        sessionId,
      )?.snapshot;
      const pane = snapshot
        ? preferredWorkspacePane(snapshot, workspaceId)
        : undefined;
      selectWorkspace(sessionId, workspaceId);
      if (pane) {
        openPaneTerminal(sessionId, pane);
        return;
      }
      select(sessionId, 'terminal');
      await runtime.client.focusWorkspace(workspaceId);
      // workspace.focus returns workspace metadata, not guaranteed post-focus
      // pane topology. This caller needs a pane immediately to open a renderer.
      const refreshed = await refreshSnapshot(sessionId);
      const refreshedPane = refreshed
        ? preferredWorkspacePane(refreshed, workspaceId)
        : undefined;
      if (!refreshedPane) throw new Error(t('session.emptyWorkspace'));
      activatePaneTerminal(sessionId, refreshedPane);
    },
    [
      activatePaneTerminal,
      openPaneTerminal,
      refreshSnapshot,
      requireRuntime,
      select,
      selectWorkspace,
      t,
    ],
  );

  const createWorkspace = useCallback(
    async (sessionId: string, name: string, cwd: string) =>
      (await requireRuntime(sessionId).client.createWorkspace(name, cwd))
        .workspace,
    [requireRuntime],
  );

  const renameWorkspace = useCallback(
    async (sessionId: string, workspaceId: string, name: string) => {
      await requireRuntime(sessionId).client.renameWorkspace(workspaceId, name);
    },
    [requireRuntime],
  );

  const closeWorkspace = useCallback(
    async (sessionId: string, workspaceId: string) => {
      await requireRuntime(sessionId).client.closeWorkspace(workspaceId);
    },
    [requireRuntime],
  );

  const closeTab = useCallback(
    async (sessionId: string, tabId: string) => {
      await requireRuntime(sessionId).client.closeTab(tabId);
    },
    [requireRuntime],
  );

  const launchTab = useCallback(
    async (
      sessionId: string,
      workspaceId: string,
      tabName: string,
      launch: TabLaunchIntent,
    ) => {
      await launchTabAndOpenCreatedTab(
        requireRuntime(sessionId).client,
        workspaceId,
        tabName,
        launch,
        (created: TabCreationResult) => {
          navigation.selectPane(null);
          terminals.openPane(sessionId, created.root_pane);
          select(sessionId, 'terminal');
        },
      );
    },
    [navigation, requireRuntime, select, terminals],
  );

  const startServer = useCallback(
    async (sessionId: string) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) return;
      try {
        await runtime.client.startServer();
        await new Promise<void>(resolve => setTimeout(resolve, 800));
        await refresh(sessionId);
      } catch (error) {
        scheduleReconnect(sessionId, error);
      }
    },
    [refresh, scheduleReconnect],
  );

  const terminalTargets = useMemo(
    () =>
      state.sessions.flatMap(session => {
        const runtime = runtimesRef.current.get(session.id);
        if (!runtime) return [];
        const sessionTerminals =
          terminals.state.get(session.id)?.terminals.sessions ?? [];
        return sessionTerminals.map(terminal => ({
          key: terminalRendererKey(session.id, terminal.terminalId),
          hostSessionId: session.id,
          client: runtime.client,
          session: terminal,
          scroll:
            session.snapshot.panes.find(
              pane => pane.terminal_id === terminal.terminalId,
            )?.scroll ?? undefined,
        }));
      }),
    [state.sessions, terminals.state],
  );

  const activeSession = getActiveLiveHostSession(state);
  return useMemo(
    () => ({
      state,
      activeSession,
      activeClient: activeSession ? getClient(activeSession.id) : undefined,
      connectingHostIds,
      restoreComplete,
      terminalTargets,
      getState,
      getClient,
      select,
      connect,
      connectSavedHost,
      close,
      closeHostById,
      refresh,
      refreshSnapshot,
      exitTerminalToHerd,
      activatePaneTerminal,
      openPaneTerminal,
      openAgentTerminal,
      openSshShell,
      closeTerminal,
      selectWorkspace,
      focusWorkspace,
      openWorkspace,
      createWorkspace,
      renameWorkspace,
      closeWorkspace,
      closeTab,
      launchTab,
      startServer,
    }),
    [
      activatePaneTerminal,
      activeSession,
      close,
      closeHostById,
      closeTab,
      closeTerminal,
      closeWorkspace,
      connect,
      connectingHostIds,
      connectSavedHost,
      createWorkspace,
      exitTerminalToHerd,
      focusWorkspace,
      getClient,
      getState,
      launchTab,
      openAgentTerminal,
      openPaneTerminal,
      openSshShell,
      openWorkspace,
      refresh,
      refreshSnapshot,
      renameWorkspace,
      restoreComplete,
      select,
      selectWorkspace,
      startServer,
      state,
      terminalTargets,
    ],
  );
}
