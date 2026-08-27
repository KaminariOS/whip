import './global.css';

import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  memo,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BlurTargetView } from 'expo-blur';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { useKeepAwake } from 'expo-keep-awake';
import { PortalHost } from '@rn-primitives/portal';
import { Alert, AppState, BackHandler, Platform, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { HostRuntimeState } from 'react-native-whip-ssh';

import { BottomNavigation } from './src/components/BottomNavigation';
import { AppBackground } from './src/components/AppBackground';
import { AppAccessLock } from './src/components/AppAccessLock';
import { ConnectionScreen } from './src/components/ConnectionScreen';
import { ConnectRequiredScreen } from './src/components/ConnectRequiredScreen';
import { DeleteHostConfirmationPopup } from './src/components/DeleteHostConfirmationPopup';
import { FullScreenOverlay } from './src/components/FullScreenOverlay';
import { HerdScreen } from './src/components/HerdScreen';
import { GlobalKeychainScreen } from './src/components/GlobalKeychainScreen';
import { GlassProvider } from './src/components/GlassSurface';
import { HostsScreen } from './src/components/HostsScreen';
import { HostSessionRecoveryScreen } from './src/components/HostSessionRecoveryScreen';
import { KnownHostsScreen } from './src/components/KnownHostsScreen';
import { LicensesScreen } from './src/components/LicensesScreen';
import { NewHostScreen } from './src/components/NewHostScreen';
import type { LiveSessionRailItem } from './src/components/LiveSessionRail';
import { MoreScreen } from './src/components/MoreScreen';
import { PaneDetail } from './src/components/PaneDetail';
import { PairingSuccessPopup } from './src/components/PairingSuccessPopup';
import { RemoteFileManager } from './src/components/RemoteFileManager';
import { LiveSessionView } from './src/components/LiveSessionView';
import { TrustHostSheet } from './src/components/TrustHostSheet';
import { AgentStatusAnimationProvider, ReducedMotionProvider, WhipMark } from './src/components/app-ui';
import type { HerdHostQueue } from './src/herdQueue';
import { emptyConnectionProfile, hostDisplayName, resolveJumpHostChain } from './src/lib/hostProfiles';
import { profileFromPairing, type PairHostResult, type PairingKeySelection } from './src/lib/sshPairing';
import { hostRuntimeSummary } from './src/lib/hostRuntimeSummary';
import {
  classifyConnectionError,
  connectionErrorContext,
  connectionErrorTranslationKeys,
} from './src/lib/connectionErrors';
import { shouldEnableAppGlass } from './src/lib/appGlass';
import { requiresBiometricForKeyUse, requiresBiometricForSavedKey } from './src/lib/biometricSecurity';
import {
  foregroundUsesBriefAlerts,
  isAgentAlertingStatus,
  tabNameForAgent,
  previousVisibleAgentStatus,
  shouldNotifyAgentTransition,
} from './src/lib/agentStatusEvents';
import { isHerdrProtocolMismatch } from './src/lib/herdrProtocol';
import { shouldRefreshLiveHost } from './src/lib/liveHostHeartbeat';
import { allSettledWithConcurrency } from './src/lib/promisePool';
import { parentRemotePath } from './src/lib/remoteFiles';
import type { TranscriptFileLinkTarget } from './src/lib/transcriptLinks';
import type { TerminalControlId } from './src/lib/terminalControls';
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
import { nextHostLivenessFailure } from './src/lib/hostLiveness';
import { launchCommandAndOpenCreatedTab } from './src/lib/herdrCreationFlows';
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
} from './src/liveHostSessions';
import { aggregateAgentStatus } from './src/lib/agentStatusAggregate';
import {
  handleMobileBack,
  initialMobileNavigation,
  selectMobileTab,
} from './src/mobileNavigation';
import {
  alertAgent,
  dismissAgentAlertsForPane,
  dismissAgentAlertsForTab,
} from './src/services/alerts';
import { deleteAgentChatCachesForHost } from './src/services/agentChatCache';
import { defaultDevicePreferences } from './src/services/devicePreferences';
import { HerdrClient, type TabCreationResult } from './src/services/HerdrClient';
import {
  isSlowHostLatency,
  recordHostLatencyFailure,
  recordSlowHostLatency,
  type HostLatencyMeasurement,
} from './src/services/latencyDiagnostics';
import { networkErrorMessage, recordNetworkDiagnostic } from './src/services/networkDiagnostics';
import {
  deleteHostProfile,
  loadConnectionProfile,
  loadHostProfiles,
  loadHostProfilesFromStorage,
  loadJumpHostConnectionProfiles,
  markHostDisconnected,
  migrateCredentialBackupsIfNeeded,
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
  knownHostsFromStorage,
  loadKnownHosts,
  parseUnknownHostKey,
  trustKnownHost,
  type UnknownHostKeyChallenge,
} from './src/services/knownHosts';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  withAppPerformanceTrace,
  type AppPerformanceTrace,
} from './src/services/performanceTrace';
import { loadTerminalHistory, saveTerminalHistory, terminalHistoryFromStorage } from './src/services/terminalHistory';
import { configureTerminalVolumeKeys } from './src/services/volumeKeys';
import {
  loadPersistedLiveHosts,
  persistedLiveHostsFromSessions,
  persistedLiveHostsIdentity,
  persistedLiveHostsFromStorage,
  savePersistedLiveHosts,
  type PersistedLiveHosts,
} from './src/services/persistedLiveHosts';
import {
  hydrateHerdrSocketPathCache,
  loadHerdrSocketPathCache,
} from './src/services/herdrSocketPathStorage';
import type { TerminalSessionStatus } from './src/terminalSessions';
import { useTheme } from './src/theme';
import type { AgentInfo, AgentStatus, AppTab, ConnectionProfile, GlobalSshKey, GlobalSshKeyMaterial, HerdrSnapshot, HostProfile, KnownHost, PaneInfo } from './src/types';
import { guiFontFamilies } from './src/lib/guiFonts';
import { terminalFontFamily } from './src/lib/terminalFonts';
import { useStartupStorage } from './src/hooks/useStartupStorage';
import { useDevicePreferences } from './src/hooks/useDevicePreferences';
import { useLiveHostTelemetry } from './src/hooks/useLiveHostTelemetry';
import { useTerminalSessions } from './src/hooks/useTerminalSessions';
import { useApplicationSecurity } from './src/hooks/useApplicationSecurity';
import { useAgentNotifications } from './src/hooks/useAgentNotifications';
import {
  useLiveHostMonitoring,
  type ReconnectRecoveryTrigger,
} from './src/hooks/useLiveHostMonitoring';

const guiFontAssets = {
  [guiFontFamilies.regular]: require('./assets/gui-fonts/Inter-Regular.ttf'),
  [guiFontFamilies.medium]: require('./assets/gui-fonts/Inter-Medium.ttf'),
  [guiFontFamilies.semiBold]: require('./assets/gui-fonts/Inter-SemiBold.ttf'),
  [guiFontFamilies.bold]: require('./assets/gui-fonts/Inter-Bold.ttf'),
  [guiFontFamilies.extraBold]: require('./assets/gui-fonts/Inter-ExtraBold.ttf'),
  [guiFontFamilies.black]: require('./assets/gui-fonts/Inter-Black.ttf'),
  [terminalFontFamily]: require('./assets/terminal-fonts/JetBrainsMono-Regular.ttf'),
};

const BACKGROUND_HOST_RESTORE_CONCURRENCY = 2;

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
    dispatchMs: measurement.dispatchMs,
  });
  recordSlowHostLatency(sessionId, measurement).catch(() => undefined);
}

function recordLatencyFailure(
  sessionId: string,
  startedAt: number,
  error: unknown,
): void {
  const totalMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const message = networkErrorMessage(error);
  recordHostLatencyFailure(sessionId, totalMs, message).catch(() => undefined);
}

const StableStatusBar = memo(function AppStatusBar({
  backgroundColor,
  hidden,
  isDark,
}: {
  backgroundColor: string;
  hidden: boolean;
  isDark: boolean;
}) {
  return (
    <StatusBar
      animated={false}
      hidden={hidden}
      barStyle={isDark ? 'light-content' : 'dark-content'}
      backgroundColor={backgroundColor}
    />
  );
});

interface LiveRuntime {
  client: HerdrClient;
  profile: ConnectionProfile;
  previousStatuses: Map<string, AgentStatus> | null;
  latencyFailureActive: boolean;
  latencyFailures: number;
  acceptHostState: (state: HostRuntimeState, changedAgentPaneIds?: string[]) => void;
}

interface RemoteFilesRequest {
  id: number;
  hostSessionId: string;
  initialPath: string;
  initialFilePath?: string;
  initialLine?: number;
  pathKey: string;
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

function withOptionalAppPerformanceTrace<Result>(
  enabled: boolean,
  name: string,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  return enabled
    ? withAppPerformanceTrace(name, operation)
    : Promise.resolve().then(operation);
}

let retainedBackgroundRuntimes: Map<string, LiveRuntime> | null = null;

function disposeRuntimes(target: Map<string, LiveRuntime>): void {
  for (const runtime of target.values()) {
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
  const startupStorage = useStartupStorage();
  const preferenceController = useDevicePreferences(startupStorage);
  const liveHostTelemetry = useLiveHostTelemetry();
  const terminalController = useTerminalSessions();
  const {
    setPreference,
    setTerminalPreferences,
    recordTerminalControlUse: recordTerminalControlPreferenceUse,
    recordLastTab,
  } = preferenceController;
  const {
    state: liveHostTelemetryState,
    get: getLiveHostTelemetry,
    recordLatency: recordLiveHostLatency,
    clearLatency: clearLiveHostLatency,
  } = liveHostTelemetry;
  const {
    state: terminalSessionsByHost,
    get: getTerminalSessions,
    restore: restoreTerminalSessions,
    remove: removeTerminalSessions,
    reconcile: reconcileHostTerminals,
    openPane: openTerminalPane,
    openSshShell: openSshTerminal,
    close: closeTerminalMetadata,
    updateStatus: updateTerminalMetadataStatus,
    updateFontSize: updateTerminalMetadataFontSize,
  } = terminalController;
  const {
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
    developerOptionsEnabled,
    language,
    keepScreenOn,
    reopenTerminalOnLaunch,
    agentCommand,
    terminal: terminalPreferences,
    terminalControlUsage,
  } = preferenceController.value;
  const preferencesLoaded = preferenceController.hydration.status !== 'loading';
  const security = useApplicationSecurity({
    preferencesLoaded,
    biometricForKeys,
    biometricOnResume,
    onBiometricForKeysChange: enabled => (
      setPreference('biometricForKeys', enabled)
    ),
    onBiometricOnResumeChange: enabled => (
      setPreference('biometricOnResume', enabled)
    ),
    biometricUnavailableTitle: t('settings.biometricUnavailable'),
    biometricUnavailableMessage: error => (
      t('settings.biometricUnavailableCopy', { error: String(error) })
    ),
  });
  const agentNotifications = useAgentNotifications();
  const notificationResponse = agentNotifications.response;
  const {
    locked: appAccessLocked,
    authenticating: appAccessAuthenticating,
    authenticateLockedApp,
    verifyBiometric,
    updateBiometricForKeys,
    updateBiometricOnResume,
  } = security;
  const runtimes = useRef(new Map<string, LiveRuntime>());
  const liveSessionsRef = useRef(emptyLiveHostSessions);
  const latencyPingsInFlight = useRef(new Map<string, LiveRuntime>());
  const probeLiveHostRef = useRef<(
    sessionId: string,
    reconnectImmediately?: boolean,
  ) => void>(() => undefined);
  const navigationBlurTargetRef = useRef<View | null>(null);
  const hostsRef = useRef<HostProfile[]>([]);
  const knownHostsRef = useRef<KnownHost[]>([]);
  const persistedLiveHostsRef = useRef<PersistedLiveHosts>({ hostIds: [], activeHostId: null });
  const restoredTerminalHostIdsRef = useRef(new Set<string>());
  const restoreStarted = useRef(false);
  const startupTraceRef = useRef<AppPerformanceTrace | null>(null);
  const tabMountTracesRef = useRef(new Map<AppTab, AppPerformanceTrace>());
  const latencyStateApplyTracesRef = useRef(new Set<AppPerformanceTrace>());
  const criticalStartupHydrationStartedRef = useRef(false);
  const deferredStartupHydrationStartedRef = useRef(false);
  const preferencesNavigationHydratedRef = useRef(false);
  const credentialMigrationStartedRef = useRef(false);
  const alertsEnabledRef = useRef(true);
  const persistentAlertDurationSecondsRef = useRef(defaultDevicePreferences.persistentAlertDurationSeconds);
  const ttsEnabledRef = useRef(false);
  const remoteFilesRequestIdRef = useRef(0);
  const remoteFilePathsRef = useRef(new Map<string, string>());
  const terminalComposerDraftsRef = useRef(new Map<string, string>());
  const unknownHostResolutionRef = useRef<((trusted: boolean) => void) | null>(null);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [editorProfile, setEditorProfile] = useState<ConnectionProfile | null>(null);
  const [newHostOpen, setNewHostOpen] = useState(false);
  const [globalSshKeys, setGlobalSshKeys] = useState<GlobalSshKey[]>([]);
  const [unlockedGlobalKeys, setUnlockedGlobalKeys] = useState<GlobalSshKeyMaterial[] | null>(null);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [knownHostsOpen, setKnownHostsOpen] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [unknownHostChallenge, setUnknownHostChallenge] = useState<UnknownHostKeyChallenge | null>(null);
  const [pairingSuccess, setPairingSuccess] = useState<PairHostResult | null>(null);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [knownHostsLoaded, setKnownHostsLoaded] = useState(false);
  const [liveHostsLoaded, setLiveHostsLoaded] = useState(false);
  const [terminalHistoryLoaded, setTerminalHistoryLoaded] = useState(false);
  const [liveHostsSafeToPersist, setLiveHostsSafeToPersist] = useState(false);
  const [terminalHistorySafeToPersist, setTerminalHistorySafeToPersist] = useState(false);
  const [liveHostRestoreComplete, setLiveHostRestoreComplete] = useState(false);
  const [connectingHostIds, setConnectingHostIds] = useState<ReadonlySet<string>>(() => new Set());
  const [connectError, setConnectError] = useState<string | null>(null);
  const [deleteHostTarget, setDeleteHostTarget] = useState<HostProfile | null>(null);
  const [deleteHostBusy, setDeleteHostBusy] = useState(false);
  const [liveSessions, setLiveSessions] = useState(emptyLiveHostSessions);
  const [navigation, setNavigation] = useState(initialMobileNavigation);
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<AppTab>>(() => new Set());
  const [herdHostFilterId, setHerdHostFilterId] = useState<string | null>(null);
  const [herdWorkspaceFilterIds, setHerdWorkspaceFilterIds] = useState<Record<string, string | null>>({});
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [remoteFilesRequest, setRemoteFilesRequest] = useState<RemoteFilesRequest | null>(null);
  const [credentialRecovery, setCredentialRecovery] = useState<CredentialRecoveryStatus>({ state: 'none', count: 0 });
  const [credentialRecoveryBusy, setCredentialRecoveryBusy] = useState(false);
  const reportHostProfilesLoadError = useEffectEvent((error: unknown) => {
    setConnectError(t('app.loadHostsError', { error: String(error) }));
  });

  const updateTerminalOpenLinksInApp = useCallback((openLinksInApp: boolean) => {
    setTerminalPreferences(current => (
      current.openLinksInApp === openLinksInApp
        ? current
        : { ...current, openLinksInApp }
    ));
  }, [setTerminalPreferences]);

  const recordTerminalControlUse = useCallback((control: TerminalControlId) => {
    recordTerminalControlPreferenceUse(control);
  }, [recordTerminalControlPreferenceUse]);

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
    for (const trace of latencyStateApplyTracesRef.current) {
      endAppPerformanceTrace(trace);
    }
    latencyStateApplyTracesRef.current.clear();
  }, [liveHostTelemetryState]);

  useEffect(() => {
    const retained = retainedBackgroundRuntimes;
    if (!retained) return;
    retainedBackgroundRuntimes = null;
    disposeRuntimes(retained);
  }, []);

  useEffect(() => {
    startupTraceRef.current = beginAppPerformanceTrace('Whip startup to first tab');
    loadGlobalSshKeys().then(setGlobalSshKeys).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (startupStorage.status === 'loading' || criticalStartupHydrationStartedRef.current) return;
    criticalStartupHydrationStartedRef.current = true;
    const load = startupStorage.status === 'loaded'
      ? loadHostProfilesFromStorage(
          startupStorage.value.hosts,
          startupStorage.value.legacyHost,
        )
      : loadHostProfiles();
    withAppPerformanceTrace('Whip startup store: hosts', () => load)
      .then(setHosts)
      .catch(error => {
        reportHostProfilesLoadError(error);
        setHosts([]);
      })
      .finally(() => setProfilesLoaded(true));
  }, [startupStorage]);

  useEffect(() => {
    if (!preferencesLoaded || preferencesNavigationHydratedRef.current) return;
    preferencesNavigationHydratedRef.current = true;
    setNavigation(current => selectMobileTab(
      current,
      preferenceController.value.lastTab === 'terminal'
        ? 'hosts'
        : preferenceController.value.lastTab,
    ));
  }, [biometricForKeys, biometricOnResume, preferenceController.value.lastTab, preferencesLoaded]);

  const appReady = profilesLoaded
    && preferencesLoaded;

  useEffect(() => {
    if (!appReady || mountedTabs.has(navigation.tab)) return;
    const tab = navigation.tab;
    const trace = beginAppPerformanceTrace(`Whip first tab mount: ${tab}`);
    if (trace) tabMountTracesRef.current.set(tab, trace);
    setMountedTabs(current => {
      if (current.has(tab)) return current;
      const next = new Set(current);
      next.add(tab);
      return next;
    });
  }, [appReady, mountedTabs, navigation.tab]);

  useEffect(() => {
    for (const [tab, trace] of tabMountTracesRef.current) {
      if (!mountedTabs.has(tab)) continue;
      endAppPerformanceTrace(trace);
      tabMountTracesRef.current.delete(tab);
    }
    if (mountedTabs.size > 0 && startupTraceRef.current) {
      endAppPerformanceTrace(startupTraceRef.current);
      startupTraceRef.current = null;
    }
  }, [mountedTabs]);

  useEffect(() => {
    if (mountedTabs.size === 0 || deferredStartupHydrationStartedRef.current) return;
    deferredStartupHydrationStartedRef.current = true;
    const snapshot = startupStorage.status === 'loaded' ? startupStorage.value : null;

    Promise.all([
      withAppPerformanceTrace('Whip startup store: known hosts', () => (
        snapshot
          ? knownHostsFromStorage(snapshot.knownHosts)
          : loadKnownHosts()
      )).catch(() => []),
      withAppPerformanceTrace('Whip startup store: live hosts', () => (
        snapshot
          ? persistedLiveHostsFromStorage(snapshot.liveHosts)
          : loadPersistedLiveHosts()
      )).then(value => ({ loaded: true as const, value }))
        .catch(() => ({
          loaded: false as const,
          value: { hostIds: [], activeHostId: null },
        })),
      withAppPerformanceTrace('Whip startup store: terminal history', () => (
        snapshot
          ? terminalHistoryFromStorage(snapshot.terminalHistory)
          : loadTerminalHistory()
      )).then(value => ({ loaded: true as const, value }))
        .catch(() => ({ loaded: false as const, value: [] as string[] })),
      withAppPerformanceTrace('Whip startup store: socket paths', () => (
        snapshot
          ? hydrateHerdrSocketPathCache(snapshot.herdrSocketPaths)
          : loadHerdrSocketPathCache()
      )).catch(() => undefined),
    ]).then(([nextKnownHosts, persistedLiveHosts, nextTerminalHistory]) => {
      setKnownHosts(nextKnownHosts);
      knownHostsRef.current = nextKnownHosts;
      persistedLiveHostsRef.current = persistedLiveHosts.value;
      setLiveHostsSafeToPersist(persistedLiveHosts.loaded);
      setTerminalHistory(nextTerminalHistory.value);
      setTerminalHistorySafeToPersist(nextTerminalHistory.loaded);
    }).finally(() => {
      setKnownHostsLoaded(true);
      setLiveHostsLoaded(true);
      setTerminalHistoryLoaded(true);
    });

    withAppPerformanceTrace('Whip startup store: credential status', credentialRecoveryStatus)
      .then(setCredentialRecovery)
      .catch(() => undefined);
  }, [mountedTabs, startupStorage]);

  useEffect(() => {
    if (!liveHostRestoreComplete || mountedTabs.size === 0 || credentialMigrationStartedRef.current) return;
    credentialMigrationStartedRef.current = true;
    withAppPerformanceTrace('Whip startup store: credential backups', () => (
      migrateCredentialBackupsIfNeeded(hostsRef.current)
    )).catch(() => undefined);
  }, [liveHostRestoreComplete, mountedTabs]);

  useEffect(() => () => {
    endAppPerformanceTrace(startupTraceRef.current);
    for (const trace of tabMountTracesRef.current.values()) endAppPerformanceTrace(trace);
    tabMountTracesRef.current.clear();
    for (const trace of latencyStateApplyTracesRef.current) endAppPerformanceTrace(trace);
    latencyStateApplyTracesRef.current.clear();
  }, []);

  useEffect(() => {
    if (!preferencesNavigationHydratedRef.current) return;
    recordLastTab(navigation.tab);
  }, [navigation.tab, recordLastTab]);

  useEffect(() => {
    if (!terminalHistoryLoaded || !terminalHistorySafeToPersist) return;
    saveTerminalHistory(terminalHistory).catch(() => undefined);
  }, [terminalHistory, terminalHistoryLoaded, terminalHistorySafeToPersist]);

  const persistedLiveHostSelection = persistedLiveHostsFromSessions(liveSessions);
  const persistedLiveHostIdentity = persistedLiveHostsIdentity(persistedLiveHostSelection);
  const persistLiveHostSelection = useEffectEvent(() => {
    savePersistedLiveHosts(persistedLiveHostsFromSessions(liveSessionsRef.current))
      .catch(() => undefined);
  });

  useEffect(() => {
    if (!liveHostRestoreComplete || !liveHostsSafeToPersist) return;
    persistLiveHostSelection();
  }, [liveHostRestoreComplete, liveHostsSafeToPersist, persistedLiveHostIdentity]);

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

  const scheduleEventReconnect = (sessionId: string, cause: unknown) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) return;
    recordNetworkDiagnostic('warn', 'event-stream-recovery-native', {
      sessionId,
      cause: networkErrorMessage(cause),
    });
  };

  const recordHostDisconnect = (hostId: string) => {
    markHostDisconnected(hostsRef.current, hostId)
      .then(setHosts)
      .catch(() => undefined);
  };

  const scheduleReconnect = (sessionId: string, cause: unknown) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) return;
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    if (session?.status === 'connected' || session?.status === 'ready') recordHostDisconnect(sessionId);
    if (isHerdrProtocolMismatch(cause)) {
      clearLiveHostLatency(sessionId);
      recordNetworkDiagnostic('error', 'control-reconnect-protocol-mismatch', {
        sessionId,
        error: networkErrorMessage(cause),
      });
      setLiveSessions(current => updateLiveHostConnection(current, sessionId, {
        status: 'error',
        error: String(cause),
      }));
      return;
    }
    recordNetworkDiagnostic('warn', 'control-recovery-requested', {
      sessionId,
      cause: networkErrorMessage(cause),
    });
    clearLiveHostLatency(sessionId);
    setLiveSessions(current => updateLiveHostConnection(current, sessionId, {
      status: 'reconnecting',
      error: String(cause),
    }));
    runtime.client.reconnectControl(runtime.profile).catch(error => {
      if (runtimes.current.get(sessionId) !== runtime) return;
      recordNetworkDiagnostic('warn', 'control-recovery-native-failed', {
        sessionId,
        error: networkErrorMessage(error),
      });
    });
  };

  const createRuntime = (sessionId: string, profile: ConnectionProfile): LiveRuntime => {
    const runtime = {
      client: new HerdrClient(),
      profile,
      previousStatuses: null,
      latencyFailureActive: false,
      latencyFailures: 0,
    } as LiveRuntime;
    const acceptHostState = (state: HostRuntimeState, changedAgentPaneIds: string[] = []) => {
      if (runtimes.current.get(sessionId) !== runtime) return;
      const snapshot = runtime.client.snapshotFromHostState(state);
      const visibleSnapshot = findLiveHostSession(liveSessionsRef.current, sessionId)?.snapshot;
      const statuses = new Map(snapshot.agents.map(agent => [agent.pane_id, agent.agent_status]));
      const changed = new Set(changedAgentPaneIds);
      if (runtime.previousStatuses) {
        for (const agent of snapshot.agents) {
          if (runtime.previousStatuses.get(agent.pane_id) !== agent.agent_status) {
            changed.add(agent.pane_id);
          }
        }
      }
      for (const paneId of changed) {
        const agent = snapshot.agents.find(item => item.pane_id === paneId);
        const status = agent?.agent_status
          ?? snapshot.panes.find(item => item.pane_id === paneId)?.agent_status;
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
          agent
          && alertsEnabledRef.current
          && shouldNotifyAgentTransition(previous, status)
        ) {
          const useBriefAlert = foregroundUsesBriefAlerts(AppState.currentState === 'active');
          alertAgent(agent, ttsEnabledRef.current, {
            hostId: sessionId,
            paneId,
          }, tabNameForAgent(agent, snapshot.tabs),
          useBriefAlert ? 'brief' : 'persistent',
          persistentAlertDurationSecondsRef.current * 1_000).catch(() => undefined);
        }
        recordNetworkDiagnostic('info', 'agent-status-state-change', {
          sessionId,
          paneId,
          status,
          revision: state.revision,
        });
      }
      runtime.previousStatuses = statuses;
      startTransition(() => {
        setLiveSessions(current => applyNativeHostState(
          current,
          sessionId,
          state,
          snapshot,
        ));
        reconcileHostTerminals(sessionId, snapshot.panes);
      });
      if (state.freshness === 'fresh' || state.freshness === 'unavailable') {
        setConnectError(null);
        setLiveSessions(current => updateLiveHostConnection(current, sessionId, { status: 'ready' }));
      }
    };
    runtime.client.setRuntimeEventHandler(event => {
      if (runtimes.current.get(sessionId) !== runtime) return;
      if (event.type === 'connection-state') {
        if (event.state === 'reconnecting' || event.state === 'connecting') {
          setLiveSessions(current => updateLiveHostConnection(current, sessionId, {
            status: 'reconnecting',
            error: event.error,
            reconnectAttempt: event.reconnectAttempt,
          }));
        } else if (event.state === 'failed') {
          setLiveSessions(current => updateLiveHostConnection(current, sessionId, {
            status: 'error',
            error: event.error,
            reconnectAttempt: event.reconnectAttempt,
          }));
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
      if (event.type === 'terminal-state' && event.state === 'failed' && event.error?.includes('recovery exhausted')) {
        recordNetworkDiagnostic('error', 'terminal-recovery-exhausted', {
          sessionId,
          terminalId: event.terminalId,
          error: event.error,
        });
        return;
      }
      if (event.type === 'fatal-error') {
        setLiveSessions(current => updateLiveHostConnection(current, sessionId, {
          status: 'error',
          error: event.message,
        }));
      }
    });
    runtime.acceptHostState = acceptHostState;
    return runtime;
  };

  async function refreshHostSnapshot(sessionId: string): Promise<HerdrSnapshot | null> {
    const runtime = runtimes.current.get(sessionId);
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    if (!runtime || !canRefreshLiveHostSession(session)) return null;
    const trace = beginAppPerformanceTrace('Whip host snapshot refresh');
    try {
      const state = await runtime.client.refreshHostState();
      const snapshot = runtime.client.snapshotFromHostState(state);
      if (state.syncStatus === 'error') {
        recordNetworkDiagnostic('error', 'snapshot-refresh-failed', {
          sessionId,
          connectionStatus: session.status,
          freshness: state.freshness,
          error: state.error,
        });
        return null;
      }
      return snapshot;
    } finally {
      endAppPerformanceTrace(trace);
    }
  }

  async function refreshHost(sessionId: string): Promise<void> {
    await refreshHostSnapshot(sessionId);
  }

  const resumeLiveConnections = (reconcile = false) => {
    for (const session of liveSessionsRef.current.sessions) {
      const sessionId = session.id;
      const runtime = runtimes.current.get(sessionId);
      if (
        !runtime ||
        !shouldRefreshLiveHost(
          session,
          reconcile,
        )
      )
        continue;
      refreshHost(sessionId).catch(() => undefined);
    }
  };

  const restartLiveConnections = (trigger: ReconnectRecoveryTrigger) => {
    for (const session of liveSessionsRef.current.sessions) {
      const runtime = runtimes.current.get(session.id);
      if (!runtime) continue;
      if (trigger === 'app-resume' && session.status !== 'error' && session.status !== 'reconnecting') continue;

      scheduleReconnect(
        session.id,
        trigger === 'network-change'
          ? t('app.networkChangedReconnect')
          : session.connectionError || t('app.resumeReconnect'),
      );
    }
  };

  const probeLiveHost = (
    sessionId: string,
    reconnectImmediately = false,
  ) => {
    if (AppState.currentState !== 'active') return;
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    if (session?.status !== 'ready') return;
    const runtime = runtimes.current.get(sessionId);
    if (!runtime || latencyPingsInFlight.current.get(sessionId) === runtime) return;

    latencyPingsInFlight.current.set(sessionId, runtime);
    const latencyProbeStartedAt = performance.now();
    runtime.client.measureLatency()
      .then(measurement => {
        if (runtimes.current.get(sessionId) !== runtime) return;
        const { latencyMs } = measurement;
        recordLatencyMeasurement(sessionId, measurement);
        runtime.latencyFailures = 0;
        if (runtime.latencyFailureActive) {
          runtime.latencyFailureActive = false;
          recordNetworkDiagnostic('info', 'latency-probe-recovered', {
            sessionId,
            latencyMs,
          });
        }
        const trace = beginAppPerformanceTrace('Whip host latency state apply');
        startTransition(() => {
          const changed = recordLiveHostLatency(sessionId, latencyMs);
          if (trace && changed) latencyStateApplyTracesRef.current.add(trace);
          else endAppPerformanceTrace(trace);
        });
      })
      .catch(error => {
        if (runtimes.current.get(sessionId) !== runtime) return;
        const decision = nextHostLivenessFailure(
          runtime.latencyFailures,
          reconnectImmediately,
        );
        runtime.latencyFailures = decision.failures;
        clearLiveHostLatency(sessionId);
        if (!runtime.latencyFailureActive) {
          runtime.latencyFailureActive = true;
          recordLatencyFailure(sessionId, latencyProbeStartedAt, error);
          recordNetworkDiagnostic('warn', 'latency-probe-failed', {
            sessionId,
            failures: decision.failures,
            error: networkErrorMessage(error),
          });
        }
        if (decision.reconnect) scheduleReconnect(sessionId, error);
      })
      .finally(() => {
        if (latencyPingsInFlight.current.get(sessionId) === runtime) {
          latencyPingsInFlight.current.delete(sessionId);
        }
      });
  };
  probeLiveHostRef.current = probeLiveHost;

  const measureConnectedHostLatencies = (
    reconnectImmediately = false,
  ) => {
    for (const session of liveSessionsRef.current.sessions) {
      if (session.status === 'ready') {
        probeLiveHost(session.id, reconnectImmediately);
      }
    }
  };

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
      unknownHostResolutionRef.current?.(false);
      unknownHostResolutionRef.current = resolve;
      setUnknownHostChallenge(challenge);
    })
  ), []);

  const resolveUnknownHost = useCallback((trusted: boolean) => {
    const resolve = unknownHostResolutionRef.current;
    unknownHostResolutionRef.current = null;
    setUnknownHostChallenge(null);
    resolve?.(trusted);
  }, []);

  useLiveHostMonitoring({
    liveHostCount: liveSessions.sessions.length,
    alertsEnabled,
    restoreComplete: liveHostRestoreComplete,
    hostsVisible: navigation.tab === 'hosts',
    appAccessLocked,
    restartConnections: restartLiveConnections,
    measureLatencies: measureConnectedHostLatencies,
    resumeConnections: resumeLiveConnections,
    onBackgroundMonitoringError: error => {
      setConnectError(t('app.backgroundUnavailable', { error: String(error) }));
    },
  });

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (licensesOpen) {
        setLicensesOpen(false);
        return true;
      }
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
      if (newHostOpen) {
        setNewHostOpen(false);
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
  }, [editorProfile, knownHostsOpen, licensesOpen, navigation, newHostOpen, selectedPaneId, unlockedGlobalKeys]);

  const selectTab = (tab: AppTab) => setNavigation(current => selectMobileTab(current, tab));

  const closeLiveHost = useCallback((sessionId: string, recordDisconnect = true) => {
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    if (session) {
      if (recordDisconnect) recordHostDisconnect(session.hostId);
    }
    removeTerminalSessions(sessionId);
    const runtime = runtimes.current.get(sessionId);
    if (runtime) {
      runtime.client.releaseAllTerminals()
        .finally(() => runtime.client.disconnect());
      runtimes.current.delete(sessionId);
    }
    clearLiveHostLatency(sessionId);
    setSelectedPaneId(null);
    setRemoteFilesRequest(current => current?.hostSessionId === sessionId ? null : current);
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
  }, [clearLiveHostLatency, removeTerminalSessions]);

  const trackHostConnection = (hostId: string, isConnecting: boolean) => {
    setConnectingHostIds(current => {
      if (current.has(hostId) === isConnecting) return current;
      const next = new Set(current);
      if (isConnecting) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  };

  const connect = async (
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
    if (trackConnecting) {
      trackHostConnection(nextProfile.id, true);
    }
    setConnectError(null);
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === nextProfile.id);
    const reusingConnectingSession = Boolean(
      reuseConnectingSession
      && existing
      && !runtimes.current.has(existing.id),
    );
    if (existing && !reusingConnectingSession) closeLiveHost(existing.id);
    let runtime: LiveRuntime | null = null;
    let liveSessionOpened = false;
    try {
      const jumpProfiles = await withOptionalAppPerformanceTrace(
        traceStartupRestore,
        'Whip startup restore: jump credentials',
        () => loadJumpHostConnectionProfiles(hostsRef.current, nextProfile),
      );
      const jumpWithoutCredential = jumpProfiles.find(profile => !profile.secret);
      if (jumpWithoutCredential) {
        throw new Error(`${hostDisplayName(jumpWithoutCredential)} needs a saved SSH credential before it can be used as a jump host`);
      }
      const protectedConnection = [nextProfile, ...jumpProfiles].some(profile => (
        requiresBiometricForKeyUse(profile, security.isKeyProtectionEnabled())
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
          await withOptionalAppPerformanceTrace(
            traceStartupRestore,
            'Whip startup restore: SSH connect',
            () => runtime!.client.connect(nextProfile, jumpProfiles),
          );
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
      const initialState = runtime.client.hostState();
      const initial = runtime.client.snapshotFromHostState(initialState);
      const restoredTerminals = await withOptionalAppPerformanceTrace(
        traceStartupRestore,
        'Whip startup restore: terminal state',
        () => restoreTerminalSessions(sessionId, nextProfile.id, initial),
      );
      if (restoredTerminals.activeTerminalId) restoredTerminalHostIdsRef.current.add(nextProfile.id);
      runtime.previousStatuses = new Map(initial.agents.map(agent => [agent.pane_id, agent.agent_status]));
      // Publish the Rust-owned state projection only after the transport exists.
      runtimes.current.set(sessionId, runtime);
      setLiveSessions(current => {
        let next = openLiveHostSession(
          current,
          savedHost,
          sessionId,
          activateSession,
        );
        next = updateLiveHostConnection(next, sessionId, { status: 'ready' });
        return applyNativeHostState(next, sessionId, initialState, initial);
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
      return true;
    } catch (error) {
      const message = t(connectionErrorTranslationKeys[classifyConnectionError(error)], {
        host: hostKeyErrorHost(error) || hostDisplayName(nextProfile),
        ...connectionErrorContext(error),
      });
      setConnectError(message);
      if (reuseConnectingSession) {
        setLiveSessions(current => updateLiveHostConnection(current, nextProfile.id, {
          status: 'error',
          error: message,
        }));
      }
      if (runtime) {
        if (liveSessionOpened) {
          scheduleReconnect(nextProfile.id, error);
        } else {
          runtime.client.disconnect();
        }
      }
      if (navigate) setNavigation(current => selectMobileTab(current, 'hosts'));
      return false;
    } finally {
      if (trackConnecting) {
        trackHostConnection(nextProfile.id, false);
      }
    }
  };

  const restorePersistedLiveHosts = useEffectEvent(async () => {
    const trace = beginAppPerformanceTrace('Whip startup restore live hosts');
    try {
      const persisted = persistedLiveHostsRef.current;
      const persistedHosts = persisted.hostIds
        .map(hostId => hostsRef.current.find(item => item.id === hostId))
        .filter((host): host is HostProfile => Boolean(host));
      setLiveSessions(current => {
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
          return [host, ...resolveJumpHostChain(hostsRef.current, host)].some(candidate => (
            requiresBiometricForSavedKey(candidate, security.isKeyProtectionEnabled())
          ));
        } catch {
          return requiresBiometricForSavedKey(host, security.isKeyProtectionEnabled());
        }
      });
      const protectedKeyAccessGranted = !hasProtectedKey || await withAppPerformanceTrace(
        'Whip startup restore: biometric',
        verifyBiometric,
      );
      const restoreHost = async (hostId: string) => {
        const host = hostsRef.current.find(item => item.id === hostId);
        if (!host) return;
        let protectedKey = requiresBiometricForSavedKey(host, security.isKeyProtectionEnabled());
        try {
          protectedKey = [host, ...resolveJumpHostChain(hostsRef.current, host)].some(candidate => (
            requiresBiometricForSavedKey(candidate, security.isKeyProtectionEnabled())
          ));
        } catch {
          // The normal connect path reports a missing or cyclic jump-host configuration.
        }
        if (protectedKey && !protectedKeyAccessGranted) {
          setLiveSessions(current => closeLiveHostSession(current, hostId));
          return;
        }
        try {
          const profile = await withAppPerformanceTrace(
            'Whip startup restore: credentials',
            () => loadConnectionProfile(host),
          );
          if (!profile.secret) throw new Error('Saved SSH credential is unavailable');
          await connect(profile, {
            persistProfile: false,
            navigate: false,
            trackConnecting: false,
            activateSession: hostId === persisted.activeHostId,
            reuseConnectingSession: true,
            biometricVerified: protectedKey,
            traceStartupRestore: true,
          });
        } catch (error) {
          const message = t('app.restoreHostError', { host: hostDisplayName(host), error: String(error) });
          setConnectError(message);
          setLiveSessions(current => updateLiveHostConnection(current, hostId, {
            status: 'error',
            error: message,
          }));
        }
      };
      const validHostIds = persistedHosts.map(host => host.id);
      const activeHostId = persisted.activeHostId && validHostIds.includes(persisted.activeHostId)
        ? persisted.activeHostId
        : null;
      let activeTerminalReopened = false;
      if (activeHostId) {
        await withAppPerformanceTrace(
          'Whip startup restore: active host',
          () => restoreHost(activeHostId),
        );
        setLiveSessions(current => selectLiveHostSession(current, activeHostId));
        if (reopenTerminalOnLaunch && restoredTerminalHostIdsRef.current.has(activeHostId)) {
          setNavigation(current => selectMobileTab(current, 'terminal'));
          activeTerminalReopened = true;
        }
      }
      const backgroundHostIds = validHostIds.filter(hostId => hostId !== activeHostId);
      await withAppPerformanceTrace(
        'Whip startup restore: background hosts',
        () => allSettledWithConcurrency(
          backgroundHostIds,
          BACKGROUND_HOST_RESTORE_CONCURRENCY,
          restoreHost,
        ),
      );
      if (persisted.activeHostId) {
        setLiveSessions(current => {
          const active = current.sessions.find(session => session.hostId === persisted.activeHostId);
          return active ? selectLiveHostSession(current, active.id) : current;
        });
      }
      if (reopenTerminalOnLaunch && !activeTerminalReopened) {
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
    } finally {
      endAppPerformanceTrace(trace);
    }
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

  const savePairedHost = async (result: PairHostResult, key: PairingKeySelection) => {
    const nextKnownHosts = await trustKnownHost(knownHostsRef.current, {
      host: result.sshHost,
      port: result.sshPort,
      keyType: result.sshHostKeyType,
      publicKey: result.sshHostPublicKey,
      fingerprint: result.sshHostFingerprint,
    });
    knownHostsRef.current = nextKnownHosts;
    setKnownHosts(nextKnownHosts);
    const profile = profileFromPairing(result, key);
    const saved = await saveConnectionProfile(hostsRef.current, profile);
    hostsRef.current = saved.hosts;
    setHosts(saved.hosts);
    setCredentialRecovery(await credentialRecoveryStatus());
    setNewHostOpen(false);
    if (!key.privateKey) return;
    setPairingSuccess(result);
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
    const activeTerminalId = getTerminalSessions(sessionId).activeTerminalId;
    const activePane = session?.snapshot.panes.find(pane => pane.terminal_id === activeTerminalId);
    const workspaceId = activePane?.workspace_id || session?.selection.workspaceId;
    setHerdHostFilterId(sessionId);
    if (workspaceId) setHerdWorkspaceFilter(sessionId, workspaceId);
    setNavigation(current => selectMobileTab(current, 'herd'));
  }, [getTerminalSessions, setHerdWorkspaceFilter]);

  const connectSavedHost = async (host: HostProfile) => {
    const existing = liveSessionsRef.current.sessions.find(session => session.hostId === host.id);
    const existingRuntime = existing ? runtimes.current.get(existing.id) : undefined;
    if (existing && existingRuntime) {
      selectLiveHost(existing.id, 'terminal');
      refreshHost(existing.id).catch(error => scheduleReconnect(existing.id, error));
      return;
    }
    // Startup restoration publishes a placeholder before SSH connects. If that
    // first connection fails, the placeholder remains useful for status and
    // persisted terminal metadata, but it cannot be refreshed: there is no
    // client runtime to refresh. A user retry must therefore perform the full
    // saved-host connection path instead of treating the record as live.
    if (existing?.status === 'connecting') {
      selectLiveHost(existing.id, 'terminal');
      return;
    }
    setConnectError(null);
    trackHostConnection(host.id, true);
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
      await connect(nextProfile, {
        persistProfile: false,
        // connectSavedHost owns this host's busy state while it also loads or
        // restores credentials before opening the transport.
        trackConnecting: false,
        // A restored error placeholder has no runtime to refresh. Keep its
        // identity and persisted terminal metadata while rebuilding the client.
        reuseConnectingSession: Boolean(existing),
      });
    } catch (error) {
      setConnectError(String(error));
    } finally {
      trackHostConnection(host.id, false);
    }
  };

  const confirmDeleteHost = (target: HostProfile) => {
    setDeleteHostTarget(target);
  };

  const deleteConfirmedHost = async () => {
    if (!deleteHostTarget || deleteHostBusy) return;
    const target = deleteHostTarget;
    setDeleteHostBusy(true);
    const live = liveSessionsRef.current.sessions.find(session => session.hostId === target.id);
    if (live) closeLiveHost(live.id, false);
    try {
      await deleteAgentChatCachesForHost(target.id);
      const next = await deleteHostProfile(hostsRef.current, target.id);
      setHosts(next);
      setCredentialRecovery(await credentialRecoveryStatus());
      setEditorProfile(null);
      setConnectError(null);
      setDeleteHostTarget(null);
    } catch (error) {
      setDeleteHostTarget(null);
      setConnectError(t('app.deleteHostError', { error: String(error) }));
    } finally {
      setDeleteHostBusy(false);
    }
  };

  const activatePaneTerminal = useCallback((sessionId: string, pane: PaneInfo) => {
    openTerminalPane(sessionId, pane);
  }, [openTerminalPane]);

  const openSshShell = useCallback((sessionId: string) => {
    setSelectedPaneId(null);
    openSshTerminal(sessionId, t('terminal.sshShell'));
    selectLiveHost(sessionId, 'terminal');
  }, [openSshTerminal, selectLiveHost, t]);

  const openPaneTerminal = (sessionId: string, pane: PaneInfo, focusAgent = false) => {
    setSelectedPaneId(null);
    openTerminalPane(sessionId, pane);
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
    if (!target || agentNotifications.wasHandled(target.notificationId)) return false;
    const resolved = resolveAgentNotificationTarget(liveSessionsRef.current, target);
    if (!resolved) return false;
    setEditorProfile(null);
    setConnectError(null);
    openPaneTerminal(resolved.sessionId, resolved.pane, true);
    agentNotifications.consume(target.notificationId);
    return true;
  });

  useEffect(() => {
    if (!liveHostRestoreComplete || !notificationResponse) return;
    openNotificationTarget();
  }, [liveHostRestoreComplete, notificationResponse]);

  const closeTerminal = useCallback((sessionId: string, terminalId: string) => {
    runtimes.current.get(sessionId)?.client.closeTerminalBridge(terminalId).catch(() => undefined);
    closeTerminalMetadata(sessionId, terminalId);
  }, [closeTerminalMetadata]);

  const updateTerminalStatus = useCallback((
    sessionId: string,
    terminalId: string,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => {
    updateTerminalMetadataStatus(sessionId, terminalId, status, error, reconnectAttempt);
  }, [updateTerminalMetadataStatus]);

  const updateTerminalFontSize = useCallback((
    sessionId: string,
    terminalId: string,
    fontSize: number,
  ) => {
    updateTerminalMetadataFontSize(sessionId, terminalId, fontSize);
  }, [updateTerminalMetadataFontSize]);

  const activeSession = getActiveLiveHostSession(liveSessions);
  const activeTelemetry = activeSession
    ? getLiveHostTelemetry(activeSession.id)
    : null;
  const activeRuntime = activeSession ? runtimes.current.get(activeSession.id) : undefined;
  const activeClient = activeRuntime?.client;
  const remoteFilesRuntime = remoteFilesRequest
    ? runtimes.current.get(remoteFilesRequest.hostSessionId)
    : undefined;
  const terminalTargets: TerminalRenderTarget[] = useMemo(
    () =>
      liveSessions.sessions.flatMap(session => {
        const runtime = runtimes.current.get(session.id);
        if (!runtime) return [];
        const terminals = terminalSessionsByHost.get(session.id)?.terminals.sessions ?? [];
        return terminals.map(terminal => ({
          key: terminalRendererKey(session.id, terminal.terminalId),
          hostSessionId: session.id,
          client: runtime.client,
          session: terminal,
          scroll: session.snapshot.panes.find(
            pane => pane.terminal_id === terminal.terminalId,
          )?.scroll ?? undefined,
        }));
      }),
    [liveSessions.sessions, terminalSessionsByHost],
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

  const openRemoteFiles = useCallback((sessionId: string, terminalId: string, target?: TranscriptFileLinkTarget) => {
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    const pane = session?.snapshot.panes.find(item => item.terminal_id === terminalId);
    if (!session || !pane) return;
    const workspace = session.snapshot.workspaces.find(
      item => item.workspace_id === pane.workspace_id,
    );
    const pathKey = `${sessionId}:${terminalId}`;
    setRemoteFilesRequest({
      id: ++remoteFilesRequestIdRef.current,
      hostSessionId: sessionId,
      initialPath: target
        ? parentRemotePath(target.path)
        : remoteFilePathsRef.current.get(pathKey)
          || pane.foreground_cwd
          || pane.cwd
          || workspace?.worktree?.checkout_path
          || '~',
      ...(target ? { initialFilePath: target.path, initialLine: target.line } : {}),
      pathKey,
    });
  }, []);

  const getTerminalComposerDraft = useCallback((sessionId: string, terminalId: string) => (
    terminalComposerDraftsRef.current.get(`${sessionId}:${terminalId}`) || ''
  ), []);

  const updateTerminalComposerDraft = useCallback((
    sessionId: string,
    terminalId: string,
    value: string,
  ) => {
    const key = `${sessionId}:${terminalId}`;
    if (value) terminalComposerDraftsRef.current.set(key, value);
    else terminalComposerDraftsRef.current.delete(key);
  }, []);

  const openAgentTerminal = (sessionId: string, agent: AgentInfo) => {
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    const pane = session?.snapshot.panes.find(item => item.pane_id === agent.pane_id);
    if (!pane) return;
    openPaneTerminal(sessionId, pane, true);
  };

  const openAgentFiles = (sessionId: string, agent: AgentInfo) => {
    const session = findLiveHostSession(liveSessionsRef.current, sessionId);
    const pane = session?.snapshot.panes.find(item => item.pane_id === agent.pane_id);
    if (!pane) return;
    openRemoteFiles(sessionId, pane.terminal_id);
  };

  const selectHerdHost = (sessionId: string | null) => {
    setHerdHostFilterId(sessionId);
    if (sessionId) setLiveSessions(current => selectLiveHostSession(current, sessionId));
  };

  const selectHerdWorkspace = (sessionId: string, workspaceId: string) => {
    setLiveSessions(current => selectLiveHostWorkspaceView(current, sessionId, workspaceId));
  };

  const openHerdWorkspace = async (sessionId: string, workspaceId: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    const currentSnapshot = findLiveHostSession(liveSessionsRef.current, sessionId)?.snapshot;
    const currentPane = currentSnapshot
      ? preferredWorkspacePane(currentSnapshot, workspaceId)
      : undefined;
    setLiveSessions(current => selectLiveHostWorkspaceView(current, sessionId, workspaceId));
    if (currentPane) {
      openPaneTerminal(sessionId, currentPane);
      return;
    }

    // A stale snapshot should not hold navigation behind an SSH round trip.
    // Show the selected workspace now, then attach a pane if refresh finds one.
    selectLiveHost(sessionId, 'terminal');
    await runtime.client.focusWorkspace(workspaceId);
    const refreshedSnapshot = await refreshHostSnapshot(sessionId);
    const pane = refreshedSnapshot
      ? preferredWorkspacePane(refreshedSnapshot, workspaceId)
      : undefined;
    if (pane) {
      activatePaneTerminal(sessionId, pane);
    } else {
      throw new Error(t('session.emptyWorkspace'));
    }
  };

  const createHerdWorkspace = async (sessionId: string, name: string, cwd: string) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    const created = await runtime.client.createWorkspace(name, cwd);
    return created.workspace;
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

  const acceptCreatedTab = useCallback((
    sessionId: string,
    created: TabCreationResult,
    navigate: boolean,
  ) => {
    setSelectedPaneId(null);
    openTerminalPane(sessionId, created.root_pane);
    if (navigate) selectLiveHost(sessionId, 'terminal');
  }, [openTerminalPane, selectLiveHost]);

  const runHerdCommand = async (
    sessionId: string,
    workspaceId: string,
    tabName: string,
    command: string,
  ) => {
    const runtime = runtimes.current.get(sessionId);
    if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
    await launchCommandAndOpenCreatedTab(
      runtime.client,
      workspaceId,
      tabName,
      command,
      created => acceptCreatedTab(sessionId, created, true),
    );
    recordTerminalHistoryEntry(command);
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

  if (!appReady) {
    return <View className="flex-1 items-center justify-center bg-background"><WhipMark accessibilityLabel={t('app.loading')} size={64} /></View>;
  }

  const terminalVisible = navigation.tab === 'terminal' && !editorProfile;
  const immersiveTerminal = terminalVisible && Boolean(activeSession);
  const activeTerminalVisible =
    immersiveTerminal && Boolean(activeSession && getTerminalSessions(activeSession.id).activeTerminalId);
  const fullscreenTerminalVisible =
    activeTerminalVisible && terminalPreferences.fullscreen;
  const fullscreenVisible = immersiveTerminal
    ? fullscreenTerminalVisible
    : fullscreenApp;
  const railSessions: LiveSessionRailItem[] = liveSessions.sessions.map(session => ({
    hostId: session.id,
    label: hostDisplayName(session.host),
    status: session.status,
    agentStatus: aggregateAgentStatus(session.snapshot.workspaces.map(workspace => workspace.agent_status)),
    terminalCount: getTerminalSessions(session.id).sessions.length,
  }));

  return (
    <>
      <StableStatusBar
        hidden={fullscreenVisible}
        backgroundColor={theme.canvas}
        isDark={isDark}
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
        enabled={shouldEnableAppGlass(appGlassEnabled, appBackgroundImageUri)}>
      <View className="flex-1 bg-background">
        <NavigationBlurTarget ref={navigationBlurTargetRef} style={styles.navigationBlurTarget}>
          {/* Keep these screens mounted: rebuilding Herd's populated native tree made
              release tab switches stall, while Terminal was already instant because
              it used this same hide-without-unmounting pattern. */}
          <View
            importantForAccessibility={immersiveTerminal ? 'no-hide-descendants' : 'auto'}
            pointerEvents={immersiveTerminal ? 'none' : 'auto'}
            style={immersiveTerminal ? styles.hiddenTab : styles.navigationForeground}>
          <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
          {mountedTabs.has('hosts') ? <View
            importantForAccessibility={navigation.tab === 'hosts' ? 'auto' : 'no-hide-descendants'}
            pointerEvents={navigation.tab === 'hosts' ? 'auto' : 'none'}
            style={navigation.tab === 'hosts' ? styles.tabScreen : styles.hiddenTab}>
            <AgentStatusAnimationProvider enabled={navigation.tab === 'hosts'}>
            <HostsScreen
              hosts={hosts}
              activeHostId={activeSession?.hostId || null}
              connectedHostIds={liveSessions.sessions
                .filter(session => session.status === 'connected' || session.status === 'ready')
                .map(session => session.hostId)}
              latencyMsByHostId={Object.fromEntries(liveSessions.sessions.map(session => [
                session.hostId,
                session.status === 'ready'
                  ? getLiveHostTelemetry(session.id).latencyMs
                  : null,
              ]))}
              runtimeByHostId={Object.fromEntries(liveSessions.sessions.map(session => [
                session.hostId,
                hostRuntimeSummary(session.snapshot),
              ]))}
              connectingHostIds={[
                ...liveSessions.sessions
                  .filter(session => session.status === 'connecting')
                  .map(session => session.hostId),
                ...connectingHostIds,
              ]}
              error={connectError}
              credentialRecovery={credentialRecovery}
              credentialRecoveryBusy={credentialRecoveryBusy}
              onAdd={() => {
                setConnectError(null);
                setNewHostOpen(true);
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
            </AgentStatusAnimationProvider>
          </View> : null}

          {mountedTabs.has('herd') ? <View
            importantForAccessibility={navigation.tab === 'herd' ? 'auto' : 'no-hide-descendants'}
            pointerEvents={navigation.tab === 'herd' ? 'auto' : 'none'}
            style={navigation.tab === 'herd' ? styles.tabScreen : styles.hiddenTab}>
            <AgentStatusAnimationProvider enabled={navigation.tab === 'herd'}>
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
                  onOpenFiles={openAgentFiles}
                  onRunCommand={runHerdCommand}
                  onOpenSpace={openHerdWorkspace}
                  onStartServer={startServer}
                  onOpenSshShell={openSshShell}
                />
              ) : <ConnectRequiredScreen destination={t('nav.herd')} onPickHost={() => selectTab('hosts')} />}
            </AgentStatusAnimationProvider>
          </View> : null}

          {mountedTabs.has('terminal') && !activeSession && navigation.tab === 'terminal' && (
            <ConnectRequiredScreen destination={t('nav.terminal')} onPickHost={() => selectTab('hosts')} />
          )}

          {mountedTabs.has('more') ? <View
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
              developerOptionsEnabled={developerOptionsEnabled}
              language={language}
              keepScreenOn={keepScreenOn}
              reopenTerminalOnLaunch={reopenTerminalOnLaunch}
              agentCommand={agentCommand}
              terminalHistory={terminalHistory}
              terminalPreferences={terminalPreferences}
              onAlertsChange={value => setPreference('alertsEnabled', value)}
              onPersistentAlertDurationChange={value => setPreference('persistentAlertDurationSeconds', value)}
              onTestPersistentAlert={() => {
                alertAgent({
                  terminal_id: 'whip-alert-test',
                  agent: 'Whip',
                  agent_status: 'done',
                  workspace_id: 'whip-alert-test',
                  tab_id: 'whip-alert-test',
                  pane_id: 'whip-alert-test',
                  focused: false,
                  revision: 0,
                }, false, {
                  hostId: 'whip-alert-test',
                  paneId: 'whip-alert-test',
                }, t('settings.testPersistentAlertTab'), 'persistent',
                persistentAlertDurationSecondsRef.current * 1_000).catch(error => {
                  setConnectError(String(error));
                });
              }}
              onTtsChange={value => setPreference('ttsEnabled', value)}
              onBiometricForKeysChange={value => { updateBiometricForKeys(value).catch(() => undefined); }}
              onBiometricOnResumeChange={value => { updateBiometricOnResume(value).catch(() => undefined); }}
              onManageGlobalKeychain={() => { openGlobalKeychain().catch(() => undefined); }}
              onManageKnownHosts={() => setKnownHostsOpen(true)}
              onOpenLicenses={() => setLicensesOpen(true)}
              onAppearanceChange={value => setPreference('appearance', value)}
              onFullscreenAppChange={value => setPreference('fullscreenApp', value)}
              onAppBackgroundImageChange={value => setPreference('appBackgroundImageUri', value)}
              onAppBackgroundDimmingChange={value => setPreference('appBackgroundDimming', value)}
              onAppGlassEnabledChange={value => setPreference('appGlassEnabled', value)}
              onDeveloperOptionsEnabledChange={value => setPreference('developerOptionsEnabled', value)}
              onLanguageChange={value => setPreference('language', value)}
              onKeepScreenOnChange={value => setPreference('keepScreenOn', value)}
              onReopenTerminalOnLaunchChange={value => setPreference('reopenTerminalOnLaunch', value)}
              onAgentCommandChange={value => setPreference('agentCommand', value)}
              onDeleteTerminalHistory={deleteTerminalHistoryEntries}
              onTerminalPreferencesChange={setTerminalPreferences}
            />
          </View> : null}

          </View>

        {mountedTabs.has('terminal') && activeSession && activeRuntime && (
          <AgentStatusAnimationProvider enabled={terminalVisible}>
            <LiveSessionView
            session={activeSession}
            client={activeRuntime.client}
            visible={terminalVisible}
            latencyMs={activeSession.status === 'ready' ? activeTelemetry?.latencyMs ?? null : null}
            latencyWarningActive={activeSession.status === 'ready' && Boolean(activeTelemetry?.latencyWarning.active)}
            terminalState={getTerminalSessions(activeSession.id)}
            terminalTargets={terminalTargets}
            appBackgroundImageUri={appBackgroundImageUri}
            appBackgroundDimming={appBackgroundDimming}
            terminalPreferences={terminalPreferences}
            terminalControlUsage={terminalControlUsage}
            terminalHistory={terminalHistory}
            onOpenFiles={openRemoteFiles}
            getTerminalComposerDraft={getTerminalComposerDraft}
            onTerminalComposerDraftChange={updateTerminalComposerDraft}
            onTerminalControlUse={recordTerminalControlUse}
            onTerminalHistoryEntry={recordTerminalHistoryEntry}
            onTerminalOpenLinksInAppChange={updateTerminalOpenLinksInApp}
            onInteraction={(sessionId, tabId) => {
              dismissAgentAlertsForTab(sessionId, tabId).catch(() => undefined);
            }}
            onExit={() => exitTerminalToHerd(activeSession.id)}
            onRefresh={refreshHost}
            onOpenPane={(sessionId, pane) => {
              setLiveSessions(current => selectLiveHostSession(current, sessionId));
              setSelectedPaneId(pane.pane_id);
            }}
            onActivateTerminal={activatePaneTerminal}
            onCloseTerminal={closeTerminal}
            onTerminalStatus={updateTerminalStatus}
            onTerminalFontSizeChange={updateTerminalFontSize}
            />
          </AgentStatusAnimationProvider>
        )}
        {mountedTabs.has('terminal') && activeSession && !activeRuntime && terminalVisible && (
          <HostSessionRecoveryScreen
            busy={activeSession.status === 'connecting' || connectingHostIds.has(activeSession.hostId)}
            error={activeSession.connectionError}
            host={hostDisplayName(activeSession.host)}
            onBack={() => exitTerminalToHerd(activeSession.id)}
            onReconnect={() => {
              connectSavedHost(activeSession.host).catch(error => setConnectError(String(error)));
            }}
          />
        )}
        </NavigationBlurTarget>

        {!immersiveTerminal && !editorProfile && !newHostOpen && unlockedGlobalKeys === null && !knownHostsOpen && !licensesOpen && (
          <BottomNavigation activeTab={navigation.tab} blurTarget={navigationBlurTargetRef} onSelect={selectTab} />
        )}

        {newHostOpen && (
          <View className="absolute inset-0 z-40 bg-background">
            <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
            <NewHostScreen
              onCancel={() => {
                setNewHostOpen(false);
                setConnectError(null);
              }}
              onManual={() => {
                setNewHostOpen(false);
                setEditorProfile(emptyConnectionProfile());
              }}
              onLoadGlobalKeys={unlockGlobalKeychain}
              onPaired={savePairedHost}
            />
          </View>
        )}

        {editorProfile && (
          <View className="absolute inset-0 z-40 bg-background">
            <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
            <ConnectionScreen
              key={editorProfile.id}
              initialProfile={editorProfile}
              hosts={hosts}
              connecting={connectingHostIds.has(editorProfile.id)}
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
            <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
            <GlobalKeychainScreen
              initialKeys={unlockedGlobalKeys}
              onChanged={updateGlobalKeys}
              onClose={() => setUnlockedGlobalKeys(null)}
            />
          </View>
        )}

        {knownHostsOpen && (
          <FullScreenOverlay>
            <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
            <KnownHostsScreen
              initialHosts={knownHosts}
              onChanged={next => {
                knownHostsRef.current = next;
                setKnownHosts(next);
              }}
              onClose={() => setKnownHostsOpen(false)}
            />
          </FullScreenOverlay>
        )}

        {licensesOpen && (
          <FullScreenOverlay>
            <AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />
            <LicensesScreen onClose={() => setLicensesOpen(false)} />
          </FullScreenOverlay>
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
      {remoteFilesRequest && remoteFilesRuntime && (
        <RemoteFileManager
          key={remoteFilesRequest.id}
          client={remoteFilesRuntime.client}
          hostId={remoteFilesRequest.hostSessionId}
          initialPath={remoteFilesRequest.initialPath}
          initialFilePath={remoteFilesRequest.initialFilePath}
          initialLine={remoteFilesRequest.initialLine}
          visible
          onPathChange={path => remoteFilePathsRef.current.set(remoteFilesRequest.pathKey, path)}
          onClose={() => setRemoteFilesRequest(current => (
            current?.id === remoteFilesRequest.id ? null : current
          ))}
        />
      )}
      <TrustHostSheet
        challenge={unknownHostChallenge}
        onCancel={() => resolveUnknownHost(false)}
        onTrust={() => resolveUnknownHost(true)}
      />
      <DeleteHostConfirmationPopup
        busy={deleteHostBusy}
        host={deleteHostTarget}
        onCancel={() => setDeleteHostTarget(null)}
        onDelete={() => { deleteConfirmedHost(); }}
      />
      <PairingSuccessPopup
        result={pairingSuccess}
        onClose={() => setPairingSuccess(null)}
      />
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
  navigationForeground: {
    flex: 1,
    zIndex: 1,
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

export default App;
