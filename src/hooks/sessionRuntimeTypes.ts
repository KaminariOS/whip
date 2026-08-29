import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { HostRuntimeState } from 'react-native-whip-ssh';

import type { LiveHostSessionsState } from '../liveHostSessions';
import type { HerdrClient } from '../services/HerdrClient';
import type { AgentStatus, ConnectionProfile } from '../types';

export interface LiveRuntime {
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

export interface SessionRuntimeStore {
  state: LiveHostSessionsState;
  setState: Dispatch<SetStateAction<LiveHostSessionsState>>;
  stateRef: MutableRefObject<LiveHostSessionsState>;
  runtimesRef: MutableRefObject<Map<string, LiveRuntime>>;
}

export interface ConnectOptions {
  persistProfile?: boolean;
  navigate?: boolean;
  trackConnecting?: boolean;
  activateSession?: boolean;
  reuseConnectingSession?: boolean;
  biometricVerified?: boolean;
  promptForUnknownHosts?: boolean;
  traceStartupRestore?: boolean;
}
