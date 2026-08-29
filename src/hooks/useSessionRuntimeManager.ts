import { useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import type { AppNavigationController } from './useAppNavigation';
import type { useAgentNotifications } from './useAgentNotifications';
import {
  useAgentNotificationNavigation,
  useAgentNotificationSideEffects,
} from './useAgentNotificationSideEffects';
import type { useApplicationSecurity } from './useApplicationSecurity';
import type { HostManagementController } from './useHostManagement';
import type { useLiveHostTelemetry } from './useLiveHostTelemetry';
import { useLiveHostMonitoring } from './useLiveHostMonitoring';
import { useSessionConnectionLifecycle } from './useSessionConnectionLifecycle';
import { useSessionRuntimeTelemetry } from './useSessionRuntimeTelemetry';
import { useSessionStartupRestore } from './useSessionStartupRestore';
import { useSessionTerminalLifecycle } from './useSessionTerminalLifecycle';
import type { useTerminalSessions } from './useTerminalSessions';
import type { LoadState } from './useStartupStorage';
import type {
  ConnectOptions,
  LiveRuntime,
  SessionRuntimeStore,
} from './sessionRuntimeTypes';
import {
  emptyLiveHostSessions,
  getActiveLiveHostSession,
  type LiveHostSessionsState,
} from '../liveHostSessions';
import type { TerminalRenderTarget } from '../lib/terminalRenderer';
import type { HerdrClient, TabLaunchIntent } from '../services/HerdrClient';
import type { StartupStorageSnapshot } from '../services/startupStorage';
import type {
  AgentInfo,
  ConnectionProfile,
  HerdrSnapshot,
  HostProfile,
  PaneInfo,
} from '../types';

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
  close: (sessionId: string, recordDisconnect?: boolean) => Promise<void>;
  closeHostById: (hostId: string, recordDisconnect?: boolean) => Promise<void>;
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

/** Coordinates the independently-owned session runtime concerns. */
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
  const stateRef = useRef(state);
  const runtimesRef = useRef(new Map<string, LiveRuntime>());
  const restoredTerminalHostIdsRef = useRef(new Set<string>());
  stateRef.current = state;
  const store: SessionRuntimeStore = {
    state,
    setState,
    stateRef,
    runtimesRef,
  };

  const handleAgentStateChange = useAgentNotificationSideEffects({
    alertsEnabled,
    persistentAlertDurationSeconds,
    ttsEnabled,
  });
  const runtimeTelemetry = useSessionRuntimeTelemetry({
    state,
    stateRef,
    runtimesRef,
    telemetry,
  });
  const connection = useSessionConnectionLifecycle({
    ...store,
    restoredTerminalHostIdsRef,
    alertsEnabled,
    hosts,
    navigation,
    security,
    terminals,
    clearLatency: runtimeTelemetry.clearLatency,
    handleAgentStateChange,
    handleRuntimeDiagnostic: runtimeTelemetry.handleRuntimeDiagnostic,
    handleReconnectRecovered: runtimeTelemetry.handleReconnectRecovered,
    t,
  });
  const restoreComplete = useSessionStartupRestore({
    state,
    stateRef,
    setState,
    restoredTerminalHostIdsRef,
    startupStorage,
    deferredHydrationReady,
    preferencesLoaded,
    terminalHistoryLoaded,
    reopenTerminalOnLaunch,
    hosts,
    navigation,
    security,
    connect: connection.connect,
    t,
  });

  useLiveHostMonitoring({
    liveHostCount: state.sessions.length,
    alertsEnabled,
    restoreComplete,
    hostsVisible,
    appAccessLocked,
    restartConnections: connection.restartConnections,
    measureLatencies: runtimeTelemetry.measureLatencies,
    resumeConnections: connection.resumeConnections,
    onBackgroundMonitoringError: monitoringError => {
      hosts.setError(
        t('app.backgroundUnavailable', { error: String(monitoringError) }),
      );
    },
  });

  const terminal = useSessionTerminalLifecycle({
    ...store,
    terminals,
    navigation,
    select: connection.select,
    scheduleReconnect: connection.scheduleReconnect,
    refreshSnapshot: connection.refreshSnapshot,
    t,
  });
  useAgentNotificationNavigation({
    notifications,
    restoreComplete,
    stateRef,
    hosts,
    openPaneTerminal: terminal.openPaneTerminal,
  });

  const activeSession = getActiveLiveHostSession(state);
  return useMemo(
    () => ({
      state,
      activeSession,
      activeClient: activeSession
        ? connection.getClient(activeSession.id)
        : undefined,
      connectingHostIds: connection.connectingHostIds,
      restoreComplete,
      terminalTargets: terminal.terminalTargets,
      getState: connection.getState,
      getClient: connection.getClient,
      select: connection.select,
      connect: connection.connect,
      connectSavedHost: connection.connectSavedHost,
      close: connection.close,
      closeHostById: connection.closeHostById,
      refresh: connection.refresh,
      refreshSnapshot: connection.refreshSnapshot,
      exitTerminalToHerd: terminal.exitTerminalToHerd,
      activatePaneTerminal: terminal.activatePaneTerminal,
      openPaneTerminal: terminal.openPaneTerminal,
      openAgentTerminal: terminal.openAgentTerminal,
      openSshShell: terminal.openSshShell,
      closeTerminal: terminal.closeTerminal,
      selectWorkspace: terminal.selectWorkspace,
      focusWorkspace: terminal.focusWorkspace,
      openWorkspace: terminal.openWorkspace,
      createWorkspace: terminal.createWorkspace,
      renameWorkspace: terminal.renameWorkspace,
      closeWorkspace: terminal.closeWorkspace,
      closeTab: terminal.closeTab,
      launchTab: terminal.launchTab,
      startServer: terminal.startServer,
    }),
    [activeSession, connection, restoreComplete, state, terminal],
  );
}
