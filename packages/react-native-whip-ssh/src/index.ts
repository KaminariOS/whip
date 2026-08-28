import {
  AgentMessageRole,
  AgentNoticeLevel,
  AgentIntegrationStatus,
  AgentScalarValue_Tags,
  AgentToolStatus,
  AgentTranscriptKind,
  AgentTranscriptDelta_Tags,
  AgentTranscriptPart_Tags,
  AgentTranscriptStatus,
  AgentTurnStatus,
  closeHerdrEventSubscription,
  closeAllHerdrTerminalBridges,
  closeHerdrTerminalBridge,
  herdrControlRequest,
  herdrTerminalInput,
  herdrTerminalResize,
  herdrTerminalScroll,
  HerdrControlRequest,
  HerdrControlResult_Tags,
  HerdrAgentSessionKind,
  HerdrAgentKind,
  HerdrAgentStatus,
  HerdrSplitDirection,
  HerdrTabLaunch,
  HerdrTabLaunchResult_Tags,
  HerdrTabLaunchStage,
  HerdrTerminalAttachLaunchMode,
  HerdrTerminalNotificationKind,
  HerdrTerminalControlEvent_Tags,
  HostConnectionState,
  HostFreshness,
  HostTerminalState,
  GitDiffKind,
  GitDiffRowKind,
  PreviewKind,
  PreviewState,
  RemoteFileKind,
  SshErrorCode as NativeSshErrorCode,
  TransferState,
  HostRuntimeEvent_Tags,
  HostSyncStatus,
  HostSshCredential,
  RuntimeDiagnosticOperation as NativeRuntimeDiagnosticOperation,
  RuntimeDiagnosticOutcome as NativeRuntimeDiagnosticOutcome,
  createHostRuntime as createHostRuntimeRust,
  HerdrEvent_Tags,
  pairHost as pairHostRust,
  prepareHerdrTerminalBridge,
  setHerdrEventSink,
  setAgentTranscriptEventSink,
  setHerdrTerminalEventSink,
  setHostRuntimeEventSink,
  setTrustedHostKeys as setTrustedHostKeysRust,
  startHerdrEventSubscription,
  startHerdrTerminalBridge,
  type HerdrBridgeError,
  type HerdrControlError,
  type HerdrControlResult,
  type HerdrEvent,
  type HerdrEventSink,
  type HerdrAgentInfo,
  type HerdrAgentSessionInfo,
  type HerdrPaneInfo,
  type HerdrPaneLayoutRect,
  type HerdrPaneLayoutSnapshot,
  type HerdrPaneScrollInfo,
  type HerdrSessionSnapshot,
  type HerdrTabInfo,
  type HerdrTerminalControlEvent,
  type HerdrTerminalEventSink,
  type HerdrWorkspaceInfo,
  type HerdrWorkspaceWorktreeInfo,
  type HerdrWorktreeInfo,
  type HostRuntimeEvent,
  type HostRuntimeLike,
  type HostStateSnapshot,
  type HostLatencyMeasurement as NativeHostLatencyMeasurement,
  type RuntimeDiagnostic as NativeRuntimeDiagnostic,
  type GitDiff as NativeGitDiff,
  type GitRepository as NativeGitRepository,
  type GitStatusEntry as NativeGitStatusEntry,
  type PreviewInfo as NativePreviewInfo,
  type RemoteDirectoryListing as NativeRemoteDirectoryListing,
  type TransferProgress as NativeTransferProgress,
  type TransferResult as NativeTransferResult,
  type AgentTranscriptEvent,
  type AgentTranscriptDelta,
  type AgentTranscriptMessage,
  type AgentTranscriptState,
  type AgentTranscriptTurn,
} from './generated-entry';
import sshNativeClient from './ssh-native';

type PairingResponse = {
  ok: boolean;
  value?: unknown;
  error?: string;
};

type BridgeEvent = Record<string, unknown> & { type: string; terminalId: string };
type BridgeHandler = (event: BridgeEvent) => void;
type ApiRequest = { method: string; params: Record<string, unknown> };
type ApiResult = Record<string, unknown> & { type: string };
type ApiEvent = { event: string; data: Record<string, unknown> };
type EventStreamEvent = { type: 'event'; event: ApiEvent } | { type: 'closed'; reason?: string };
type EventHandler = (event: EventStreamEvent) => void;
type WhipTerminalInboundTrace = {
  jsReceived: () => number | null;
  decodeComplete: (cookie: number | null) => void;
};

const bridgeHandlers = new Map<string, Map<string, BridgeHandler>>();
const eventHandlers = new Map<string, EventHandler>();
const runtimeHandlers = new Map<string, (event: RuntimeLifecycleEvent) => void>();
const agentTranscriptHandlers = new Map<string, Map<string, (event: NativeAgentTranscriptUpdate) => void>>();
const runtimeSshShellHandlers = new Map<string, Map<string, RuntimeSshShellHandler>>();

function runtimeConnectionState(state: HostConnectionState): RuntimeConnectionState {
  switch (state) {
    case HostConnectionState.Disconnected: return 'disconnected';
    case HostConnectionState.Connecting: return 'connecting';
    case HostConnectionState.Connected: return 'connected';
    case HostConnectionState.Reconnecting: return 'reconnecting';
    case HostConnectionState.Disconnecting: return 'disconnecting';
    case HostConnectionState.Failed: return 'failed';
  }
  throw new Error(`Unknown native host connection state: ${state}`);
}

function runtimeTerminalState(state: HostTerminalState): RuntimeTerminalState {
  switch (state) {
    case HostTerminalState.Opening: return 'opening';
    case HostTerminalState.Attached: return 'attached';
    case HostTerminalState.Restoring: return 'restoring';
    case HostTerminalState.Closed: return 'closed';
    case HostTerminalState.Failed: return 'failed';
  }
  throw new Error(`Unknown native terminal state: ${state}`);
}

export type NativeAgentTranscriptPart =
  | { type: 'text'; id: string; text: string; timestamp?: number }
  | { type: 'reasoning'; id: string; text: string; timestamp?: number }
  | { type: 'plan'; id: string; text: string; timestamp?: number }
  | { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string; timestamp?: number }
  | {
      type: 'tool'; id: string; callId: string; tool: string; timestamp?: number;
      state: {
        status: 'pending' | 'running' | 'completed' | 'error';
        input: Record<string, string | number | boolean>;
        output?: string; error?: string; title?: string;
        startedAt?: number; completedAt?: number; exitCode?: number;
        files: Array<{ file: string; patch?: string; before?: string; after?: string; additions?: number; deletions?: number }>;
      };
    };

export type NativeAgentTranscriptState = {
  sessionId: string;
  agent: 'codex' | 'opencode';
  revision: number;
  status: 'loading' | 'live' | 'stale' | 'unavailable' | 'error' | 'closed';
  info?: { id: string; title?: string; directory?: string; createdAt?: number; updatedAt?: number };
  messages: Array<{
    id: string; role: 'user' | 'assistant'; parentId?: string;
    createdAt?: number; completedAt?: number; error?: string;
    parts: NativeAgentTranscriptPart[];
    diffs: Array<{ file: string; patch?: string; before?: string; after?: string; additions?: number; deletions?: number }>;
  }>;
  turns: Array<{
    id: string; userMessageId?: string; assistantMessageIds: string[];
    status: 'idle' | 'working' | 'interrupted' | 'error';
    startedAt?: number; completedAt?: number;
    diffs: Array<{ file: string; patch?: string; before?: string; after?: string; additions?: number; deletions?: number }>;
  }>;
  error?: string;
};

export type NativeAgentTranscriptMessage = NativeAgentTranscriptState['messages'][number];
export type NativeAgentTranscriptTurn = NativeAgentTranscriptState['turns'][number];
export type NativeAgentTranscriptInfo = NonNullable<NativeAgentTranscriptState['info']>;

export type NativeAgentTranscriptDelta =
  | { type: 'reset'; state: NativeAgentTranscriptState }
  | { type: 'info-changed'; info?: NativeAgentTranscriptInfo }
  | { type: 'message-upserted'; index: number; message: NativeAgentTranscriptMessage }
  | { type: 'message-removed'; index: number; messageId: string }
  | { type: 'messages-truncated'; length: number }
  | { type: 'turn-upserted'; index: number; turn: NativeAgentTranscriptTurn }
  | { type: 'turns-truncated'; length: number }
  | { type: 'status-changed'; status: NativeAgentTranscriptState['status']; error?: string };

export type NativeAgentTranscriptUpdate = {
  key: string;
  revision: number;
  deltas: NativeAgentTranscriptDelta[];
  cacheWrite?: {
    namespace: string;
    key: string;
    blob: ArrayBuffer;
    confirmationToken: string;
  };
};

export type RuntimeSshConfig = {
  host: string;
  port: number;
  username: string;
  authMode: 'password' | 'key';
  secret: string;
  passphrase?: string;
  forwardAgent?: boolean;
};

export type RuntimeConfig = {
  runtimeId: string;
  ssh: RuntimeSshConfig;
  jumpHosts: RuntimeSshConfig[];
  sessionName: string;
  herdrCommand: string;
  socketPath?: string;
  cachedSocketPath?: string;
};

export type RuntimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'failed';

export type RuntimeAgentKind = 'claude' | 'codex' | 'opencode';

export type RuntimeTabLaunch =
  | { type: 'shell' }
  | { type: 'agent'; kind: RuntimeAgentKind; args?: string[] }
  | { type: 'command'; command: string };

export type RuntimeAgentIntegrationStatus =
  | 'not-installed'
  | 'current'
  | 'outdated'
  | 'needs-repair'
  | 'unknown';

export type RuntimeTabLaunchFailure = Error & {
  code: 'TAB_CREATION_FAILED' | 'TAB_LAUNCH_FAILED' | 'INVALID_TAB_LAUNCH';
  created?: ApiResult;
  launchType?: 'agent' | 'command';
  nativeFailure?: unknown;
};
export type RuntimeTerminalState = 'opening' | 'attached' | 'restoring' | 'closed' | 'failed';

export type RuntimeLifecycleEvent =
  | { type: 'connection-state'; state: RuntimeConnectionState; generation: number; reconnectAttempt: number; error?: string }
  | { type: 'reconnect-scheduled'; attempt: number; delayMs: number; reason: string }
  | { type: 'reconnected'; generation: number; restoredTerminals: number }
  | { type: 'terminal-state'; terminalId: string; state: RuntimeTerminalState; reconnectAttempt: number; retrying: boolean; error?: string }
  | { type: 'host-state'; state: RuntimeHostState; changedAgentPaneIds: string[] }
  | { type: 'event-stream-closed'; reason: string }
  | { type: 'event-stream-restored'; generation: number }
  | { type: 'transfer-progress'; progress: RuntimeTransferProgress }
  | { type: 'preview-state'; previewId: string; state: RuntimePreviewState; error?: string }
  | { type: 'diagnostic'; diagnostic: RuntimeDiagnostic }
  | { type: 'fatal-error'; message: string };

export type RuntimeDiagnosticOperation =
  | 'ssh-connect'
  | 'ssh-reconnect'
  | 'host-latency-probe'
  | 'herdr-request'
  | 'terminal-attach'
  | 'terminal-recovery'
  | 'event-stream-recovery';

export type RuntimeDiagnostic = {
  operation: RuntimeDiagnosticOperation;
  durationMs: number;
  transportDurationMs?: number;
  outcome: 'succeeded' | 'failed';
  terminalId?: string;
  error?: string;
};

export type RuntimeHostLatencyMeasurement = {
  sshRttMs: number;
  totalMs: number;
  runtimeOverheadMs: number;
};

export type RuntimeTransferState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RuntimePreviewState = 'running' | 'disconnected' | 'stopped';
export type RuntimeRemoteFileKind = 'file' | 'directory' | 'symlink' | 'other';

export type RuntimeTransferProgress = {
  transferId: string;
  bytesTransferred: number;
  totalBytes?: number;
  state: RuntimeTransferState;
};

export type RuntimeTransferResult = {
  transferId: string;
  localPath?: string;
  remotePath?: string;
};

export type RuntimeTransfer = {
  id: string;
  result: Promise<RuntimeTransferResult>;
};

export type RuntimeRemoteFileEntry = {
  name: string;
  path: string;
  kind: RuntimeRemoteFileKind;
  size?: number;
  modifiedAt?: number;
  permissions?: number;
};

export type RuntimeRemoteDirectoryListing = {
  path: string;
  entries: RuntimeRemoteFileEntry[];
};

export type RuntimeGitRepository = { root: string; hasHead: boolean };
export type RuntimeGitStatusEntry = {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath: string | null;
  absolutePath: string;
};
export type RuntimeGitDiffRowKind = 'header' | 'hunk' | 'context' | 'addition' | 'deletion' | 'meta';
export type RuntimeGitDiff = {
  kind: 'text' | 'binary' | 'empty';
  rows: Array<{
    key: string;
    kind: RuntimeGitDiffRowKind;
    content: string;
    marker: string;
    oldLine: number | null;
    newLine: number | null;
  }>;
  truncated: boolean;
};

export type RuntimePreviewInfo = {
  id: string;
  kind: 'web-forward' | 'html' | 'remote-file';
  state: RuntimePreviewState;
  url: string;
  displayUrl?: string;
};

export type RuntimeSshShellHandler = {
  data: (bytes: ArrayBuffer) => void;
  closed?: (reason: string) => void;
};

export type RuntimeHostState = {
  revision: number;
  connectionGeneration: number;
  syncGeneration: number;
  syncStatus: 'idle' | 'syncing' | 'synced' | 'error';
  freshness: 'loading' | 'fresh' | 'stale' | 'unavailable';
  error?: string;
  lastSyncedAtMs?: number;
  lastEventAtMs?: number;
  needsResync: boolean;
  focus: { workspaceId?: string; tabId?: string; paneId?: string };
  snapshot?: Record<string, unknown>;
};

function runtimeSshConfig(value: RuntimeSshConfig) {
  return {
    host: value.host,
    port: value.port,
    username: value.username,
    credential: value.authMode === 'password'
      ? HostSshCredential.Password.new({ password: value.secret })
      : HostSshCredential.Key.new({ privateKey: value.secret, passphrase: value.passphrase }),
    forwardAgent: Boolean(value.forwardAgent),
  };
}

function terminalInboundTrace(): WhipTerminalInboundTrace | undefined {
  return (globalThis as typeof globalThis & {
    __whipTerminalInboundTrace?: WhipTerminalInboundTrace;
  }).__whipTerminalInboundTrace;
}

function bridgeHandler(clientKey: string, terminalId: string): BridgeHandler | undefined {
  return bridgeHandlers.get(clientKey)?.get(terminalId);
}

function setBridgeHandler(clientKey: string, terminalId: string, handler: BridgeHandler): void {
  let handlers = bridgeHandlers.get(clientKey);
  if (!handlers) {
    handlers = new Map();
    bridgeHandlers.set(clientKey, handlers);
  }
  handlers.set(terminalId, handler);
}

function removeBridgeHandler(clientKey: string, terminalId: string): void {
  const handlers = bridgeHandlers.get(clientKey);
  handlers?.delete(terminalId);
  if (handlers?.size === 0) bridgeHandlers.delete(clientKey);
}

function bridgeError(error: unknown): Error {
  const nativeError = error as Partial<HerdrBridgeError> & {
    tag?: string;
    inner?: readonly unknown[];
  };
  const message = typeof nativeError.inner?.[0] === 'string'
    ? nativeError.inner[0]
    : error instanceof Error
      ? error.message
      : String(error);
  const result = new Error(message);
  result.name = 'HerdrBridgeError';
  if (nativeError.tag) Object.assign(result, { code: nativeError.tag });
  return result;
}

function controlError(error: unknown): Error {
  const nativeError = error as Partial<HerdrControlError> & {
    tag?: string;
    inner?: readonly unknown[];
  };
  const protocolError = nativeError.tag === 'ProtocolError';
  const message = protocolError && typeof nativeError.inner?.[1] === 'string'
    ? nativeError.inner[1]
    : typeof nativeError.inner?.[0] === 'string'
      ? nativeError.inner[0]
      : error instanceof Error
        ? error.message
        : String(error);
  const result = new Error(message);
  result.name = 'HerdrControlError';
  const code = protocolError && typeof nativeError.inner?.[0] === 'string'
    ? nativeError.inner[0]
    : nativeError.tag;
  if (code) Object.assign(result, { code });
  return result;
}

function eventError(error: unknown): Error {
  const nativeError = error as { tag?: string; inner?: readonly unknown[] };
  const message = typeof nativeError.inner?.[0] === 'string'
    ? nativeError.inner[0]
    : error instanceof Error
      ? error.message
      : String(error);
  const result = new Error(message);
  result.name = 'HerdrEventError';
  if (nativeError.tag) Object.assign(result, { code: nativeError.tag });
  return result;
}

const SSH_ERROR_CODES = {
  [NativeSshErrorCode.AuthenticationFailed]: 'AUTHENTICATION_FAILED',
  [NativeSshErrorCode.HostKeyUnknown]: 'HOST_KEY_UNKNOWN',
  [NativeSshErrorCode.HostKeyChanged]: 'HOST_KEY_CHANGED',
  [NativeSshErrorCode.UnsupportedHostCertificate]: 'UNSUPPORTED_HOST_CERTIFICATE',
  [NativeSshErrorCode.ConnectionRefused]: 'CONNECTION_REFUSED',
  [NativeSshErrorCode.ConnectionTimeout]: 'CONNECTION_TIMEOUT',
  [NativeSshErrorCode.HostUnreachable]: 'HOST_UNREACHABLE',
  [NativeSshErrorCode.ChannelUnavailable]: 'CHANNEL_UNAVAILABLE',
  [NativeSshErrorCode.SessionClosed]: 'SESSION_CLOSED',
  [NativeSshErrorCode.InvalidPrivateKey]: 'INVALID_PRIVATE_KEY',
  [NativeSshErrorCode.SftpFailure]: 'SFTP_FAILURE',
  [NativeSshErrorCode.InvalidRequest]: 'INVALID_REQUEST',
  [NativeSshErrorCode.Unknown]: 'UNKNOWN',
} as const satisfies Record<NativeSshErrorCode, string>;

function hostRuntimeError(error: unknown): Error & {
  nativeTag?: string;
  code?: string;
  details?: unknown;
  expected?: string;
  received?: number;
} {
  const nativeError = error as {
    tag?: string;
    inner?: readonly unknown[] | Record<string, unknown>;
  };
  const hostKeyCode = nativeError.tag === 'HostKeyUnknown'
    ? 'HOST_KEY_UNKNOWN'
    : nativeError.tag === 'HostKeyChanged'
      ? 'HOST_KEY_CHANGED'
      : nativeError.tag === 'UnsupportedHostCertificate'
        ? 'UNSUPPORTED_HOST_CERTIFICATE'
        : undefined;
  const structuredInner: Record<string, unknown> | undefined =
    nativeError.inner && !Array.isArray(nativeError.inner)
    ? nativeError.inner as Record<string, unknown>
    : undefined;
  const expected = nativeError.tag === 'HerdrProtocolMismatch'
    && typeof structuredInner?.expected === 'string'
    ? structuredInner.expected
    : undefined;
  const received = nativeError.tag === 'HerdrProtocolMismatch'
    && typeof structuredInner?.received === 'number'
    ? structuredInner.received
    : undefined;
  const lastReadinessError = nativeError.tag === 'HerdrReadinessTimeout'
    && typeof structuredInner?.lastError === 'string'
    ? structuredInner.lastError
    : undefined;
  const sshFailureMessage = nativeError.tag === 'SshConnectionFailure'
    && typeof structuredInner?.message === 'string'
    ? structuredInner.message
    : undefined;
  const sshFailureCode = nativeError.tag === 'SshConnectionFailure'
    && typeof structuredInner?.code === 'number'
    ? SSH_ERROR_CODES[structuredInner.code as NativeSshErrorCode]
    : undefined;
  const details = hostKeyCode === 'HOST_KEY_UNKNOWN' || hostKeyCode === 'HOST_KEY_CHANGED'
    ? (nativeError.inner as readonly unknown[] | undefined)?.[0]
    : undefined;
  const message = hostKeyCode === 'HOST_KEY_UNKNOWN'
    ? 'unknown SSH host key'
    : hostKeyCode === 'HOST_KEY_CHANGED'
      ? 'SSH host key changed'
      : hostKeyCode === 'UNSUPPORTED_HOST_CERTIFICATE'
        ? 'SSH host certificates are not supported'
        : expected !== undefined && received !== undefined
          ? `Herdr protocol mismatch: Whip supports ${expected}, server reports ${received}`
          : lastReadinessError
            ? `Herdr did not become ready: ${lastReadinessError}`
            : sshFailureMessage
              ? sshFailureMessage
              : Array.isArray(nativeError.inner) && typeof nativeError.inner[0] === 'string'
                ? nativeError.inner[0]
                : error instanceof Error
                  ? error.message
                  : String(error);
  const result = new Error(message) as Error & {
    nativeTag?: string;
    code?: string;
    details?: unknown;
    expected?: string;
    received?: number;
  };
  result.name = 'HostRuntimeError';
  if (nativeError.tag) result.nativeTag = nativeError.tag;
  if (sshFailureCode) {
    result.code = sshFailureCode;
  } else if (nativeError.tag === 'AuthenticationFailure') {
    result.code = 'AUTHENTICATION_FAILED';
  } else if (hostKeyCode) {
    result.code = hostKeyCode;
    if (details) result.details = details;
  } else if (nativeError.tag === 'HerdrUnavailable') {
    result.code = 'HERDR_UNAVAILABLE';
  } else if (nativeError.tag === 'TransferCancelled') {
    result.code = 'TRANSFER_CANCELLED';
  } else if (nativeError.tag === 'HerdrProtocolMismatch') {
    result.code = 'HERDR_PROTOCOL_MISMATCH';
    result.expected = expected;
    result.received = received;
  } else if (nativeError.tag === 'HerdrReadinessTimeout') {
    result.code = 'HERDR_READINESS_TIMEOUT';
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function runtimeAgentKind(kind: RuntimeAgentKind): HerdrAgentKind {
  switch (kind) {
    case 'claude': return HerdrAgentKind.Claude;
    case 'codex': return HerdrAgentKind.Codex;
    case 'opencode': return HerdrAgentKind.OpenCode;
  }
}

function nativeNumber(value: bigint | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function nativeAgentStatus(value: AgentTranscriptStatus): NativeAgentTranscriptState['status'] {
  switch (value) {
    case AgentTranscriptStatus.Live: return 'live';
    case AgentTranscriptStatus.Stale: return 'stale';
    case AgentTranscriptStatus.Unavailable: return 'unavailable';
    case AgentTranscriptStatus.Error: return 'error';
    case AgentTranscriptStatus.Closed: return 'closed';
    default: return 'loading';
  }
}

function nativeToolStatus(value: AgentToolStatus): 'pending' | 'running' | 'completed' | 'error' {
  switch (value) {
    case AgentToolStatus.Running: return 'running';
    case AgentToolStatus.Completed: return 'completed';
    case AgentToolStatus.Error: return 'error';
    default: return 'pending';
  }
}

function nativeAgentPart(part: AgentTranscriptState['messages'][number]['parts'][number]): NativeAgentTranscriptPart {
  switch (part.tag) {
    case AgentTranscriptPart_Tags.Text: {
      const inner = part.inner as { id: string; text: string; timestampMs?: bigint };
      return { type: 'text', id: inner.id, text: inner.text, timestamp: nativeNumber(inner.timestampMs) };
    }
    case AgentTranscriptPart_Tags.Reasoning: {
      const inner = part.inner as { id: string; text: string; timestampMs?: bigint };
      return { type: 'reasoning', id: inner.id, text: inner.text, timestamp: nativeNumber(inner.timestampMs) };
    }
    case AgentTranscriptPart_Tags.Plan: {
      const inner = part.inner as { id: string; text: string; timestampMs?: bigint };
      return { type: 'plan', id: inner.id, text: inner.text, timestamp: nativeNumber(inner.timestampMs) };
    }
    case AgentTranscriptPart_Tags.Notice: {
      const inner = part.inner as { id: string; level: AgentNoticeLevel; text: string; timestampMs?: bigint };
      return {
        type: 'notice', id: inner.id, text: inner.text, timestamp: nativeNumber(inner.timestampMs),
        level: inner.level === AgentNoticeLevel.Warning ? 'warning' : inner.level === AgentNoticeLevel.Error ? 'error' : 'info',
      };
    }
    case AgentTranscriptPart_Tags.Tool: {
      const inner = part.inner as Extract<AgentTranscriptState['messages'][number]['parts'][number], { tag: AgentTranscriptPart_Tags.Tool }>['inner'];
      const input: Record<string, string | number | boolean> = {};
      for (const field of inner.state.input) {
        switch (field.value.tag) {
          case AgentScalarValue_Tags.String: input[field.key] = field.value.inner.value; break;
          case AgentScalarValue_Tags.Number: input[field.key] = field.value.inner.value; break;
          case AgentScalarValue_Tags.Boolean: input[field.key] = field.value.inner.value; break;
        }
      }
      return {
        type: 'tool', id: inner.id, callId: inner.callId, tool: inner.tool,
        timestamp: nativeNumber(inner.timestampMs),
        state: {
          status: nativeToolStatus(inner.state.status), input,
          output: inner.state.output, error: inner.state.error, title: inner.state.title,
          startedAt: nativeNumber(inner.state.startedAtMs), completedAt: nativeNumber(inner.state.completedAtMs),
          exitCode: inner.state.exitCode === undefined ? undefined : Number(inner.state.exitCode),
          files: inner.state.files.map(file => ({ ...file })),
        },
      };
    }
  }
}

function nativeAgentInfo(value: NonNullable<AgentTranscriptState['info']>): NativeAgentTranscriptInfo {
  return {
    id: value.id, title: value.title, directory: value.directory,
    createdAt: nativeNumber(value.createdAtMs), updatedAt: nativeNumber(value.updatedAtMs),
  };
}

function nativeAgentMessage(message: AgentTranscriptMessage): NativeAgentTranscriptMessage {
  return {
    id: message.id,
    role: message.role === AgentMessageRole.Assistant ? 'assistant' : 'user',
    parentId: message.parentId,
    createdAt: nativeNumber(message.createdAtMs), completedAt: nativeNumber(message.completedAtMs),
    error: message.error,
    parts: message.parts.map(nativeAgentPart),
    diffs: message.diffs.map(file => ({ ...file })),
  };
}

function nativeAgentTurn(turn: AgentTranscriptTurn): NativeAgentTranscriptTurn {
  return {
    id: turn.id, userMessageId: turn.userMessageId, assistantMessageIds: [...turn.assistantMessageIds],
    status: turn.status === AgentTurnStatus.Working ? 'working'
      : turn.status === AgentTurnStatus.Interrupted ? 'interrupted'
        : turn.status === AgentTurnStatus.Error ? 'error' : 'idle',
    startedAt: nativeNumber(turn.startedAtMs), completedAt: nativeNumber(turn.completedAtMs),
    diffs: turn.diffs.map(file => ({ ...file })),
  };
}

function nativeAgentTranscript(value: AgentTranscriptState): NativeAgentTranscriptState {
  return {
    sessionId: value.sessionId,
    agent: value.agent === AgentTranscriptKind.OpenCode ? 'opencode' : 'codex',
    revision: Number(value.revision),
    status: nativeAgentStatus(value.status),
    info: value.info ? nativeAgentInfo(value.info) : undefined,
    messages: value.messages.map(nativeAgentMessage),
    turns: value.turns.map(nativeAgentTurn),
    error: value.error,
  };
}

function nativeAgentDelta(delta: AgentTranscriptDelta): NativeAgentTranscriptDelta {
  switch (delta.tag) {
    case AgentTranscriptDelta_Tags.Reset:
      return { type: 'reset', state: nativeAgentTranscript(delta.inner.state) };
    case AgentTranscriptDelta_Tags.InfoChanged:
      return { type: 'info-changed', info: delta.inner.info ? nativeAgentInfo(delta.inner.info) : undefined };
    case AgentTranscriptDelta_Tags.MessageUpserted:
      return { type: 'message-upserted', index: delta.inner.index, message: nativeAgentMessage(delta.inner.message) };
    case AgentTranscriptDelta_Tags.MessageRemoved:
      return { type: 'message-removed', index: delta.inner.index, messageId: delta.inner.messageId };
    case AgentTranscriptDelta_Tags.MessagesTruncated:
      return { type: 'messages-truncated', length: delta.inner.length };
    case AgentTranscriptDelta_Tags.TurnUpserted:
      return { type: 'turn-upserted', index: delta.inner.index, turn: nativeAgentTurn(delta.inner.turn) };
    case AgentTranscriptDelta_Tags.TurnsTruncated:
      return { type: 'turns-truncated', length: delta.inner.length };
    case AgentTranscriptDelta_Tags.StatusChanged:
      return { type: 'status-changed', status: nativeAgentStatus(delta.inner.status), error: delta.inner.error };
  }
}

function nativeAgentUpdate(event: AgentTranscriptEvent): NativeAgentTranscriptUpdate {
  return {
    key: event.key,
    revision: Number(event.update.revision),
    deltas: event.update.deltas.map(nativeAgentDelta),
    cacheWrite: event.cacheWrite ? {
      namespace: event.cacheWrite.namespace,
      key: event.cacheWrite.key,
      blob: event.cacheWrite.blob,
      confirmationToken: event.cacheWrite.confirmationToken,
    } : undefined,
  };
}

function splitDirection(value: unknown): HerdrSplitDirection {
  if (value === 'right') return HerdrSplitDirection.Right;
  if (value === 'down') return HerdrSplitDirection.Down;
  throw new Error('pane split direction must be right or down');
}

function splitDirectionString(value: HerdrSplitDirection): 'right' | 'down' {
  return value === HerdrSplitDirection.Down ? 'down' : 'right';
}

function agentStatus(value: HerdrAgentStatus): 'idle' | 'working' | 'blocked' | 'done' | 'unknown' {
  switch (value) {
    case HerdrAgentStatus.Idle: return 'idle';
    case HerdrAgentStatus.Working: return 'working';
    case HerdrAgentStatus.Blocked: return 'blocked';
    case HerdrAgentStatus.Done: return 'done';
    case HerdrAgentStatus.Unknown: return 'unknown';
  }
}

function agentSessionKind(value: HerdrAgentSessionKind): 'id' | 'path' {
  return value === HerdrAgentSessionKind.Path ? 'path' : 'id';
}

function nativeTerminalAttachLaunchMode(value: number): HerdrTerminalAttachLaunchMode {
  if (value === 1) return HerdrTerminalAttachLaunchMode.LegacyTerminalAttach;
  if (value === 2) return HerdrTerminalAttachLaunchMode.TerminalAttach;
  throw new Error(`unsupported Herdr terminal attach launch mode ${value}`);
}

function terminalNotificationKind(value: HerdrTerminalNotificationKind): 0 | 1 | 2 {
  switch (value) {
    case HerdrTerminalNotificationKind.Sound: return 0;
    case HerdrTerminalNotificationKind.Toast: return 1;
    case HerdrTerminalNotificationKind.SystemToast: return 2;
  }
}

function controlRequest(request: ApiRequest): HerdrControlRequest {
  const params = request.params || {};
  const text = (key: string): string => String(params[key] ?? '');
  switch (request.method) {
    case 'ping': return HerdrControlRequest.Ping.new();
    case 'session.snapshot': return HerdrControlRequest.SessionSnapshot.new();
    case 'workspace.create': return HerdrControlRequest.WorkspaceCreate.new({
      label: optionalString(params.label),
      cwd: optionalString(params.cwd),
    });
    case 'workspace.focus': return HerdrControlRequest.WorkspaceFocus.new({ workspaceId: text('workspace_id') });
    case 'workspace.rename': return HerdrControlRequest.WorkspaceRename.new({ workspaceId: text('workspace_id'), label: text('label') });
    case 'workspace.close': return HerdrControlRequest.WorkspaceClose.new({ workspaceId: text('workspace_id') });
    case 'tab.create': return HerdrControlRequest.TabCreate.new({ workspaceId: text('workspace_id'), label: optionalString(params.label) });
    case 'tab.focus': return HerdrControlRequest.TabFocus.new({ tabId: text('tab_id') });
    case 'tab.rename': return HerdrControlRequest.TabRename.new({ tabId: text('tab_id'), label: text('label') });
    case 'tab.close': return HerdrControlRequest.TabClose.new({ tabId: text('tab_id') });
    case 'pane.read': return HerdrControlRequest.PaneRead.new({ paneId: text('pane_id'), lines: Number(params.lines) });
    case 'pane.focus': return HerdrControlRequest.PaneFocus.new({ paneId: text('pane_id') });
    case 'pane.rename': return HerdrControlRequest.PaneRename.new({ paneId: text('pane_id'), label: optionalString(params.label) });
    case 'pane.split': return HerdrControlRequest.PaneSplit.new({ paneId: text('target_pane_id'), direction: splitDirection(params.direction) });
    case 'pane.zoom': return HerdrControlRequest.PaneZoom.new({ paneId: text('pane_id') });
    case 'pane.close': return HerdrControlRequest.PaneClose.new({ paneId: text('pane_id') });
    case 'pane.send_input': return HerdrControlRequest.PaneSendInput.new({ paneId: text('pane_id'), text: text('text'), keys: stringArray(params.keys) });
    case 'pane.send_text': return HerdrControlRequest.PaneSendText.new({ paneId: text('pane_id'), text: text('text') });
    case 'pane.send_keys': return HerdrControlRequest.PaneSendKeys.new({ paneId: text('pane_id'), keys: stringArray(params.keys) });
    case 'agent.focus': return HerdrControlRequest.AgentFocus.new({ target: text('target') });
    case 'agent.prompt': return HerdrControlRequest.AgentPrompt.new({ target: text('target'), text: text('text') });
    default: throw new Error(`Unsupported Herdr API method ${request.method}`);
  }
}

function stringRecord(value: Map<string, string> | undefined): Record<string, string> | undefined {
  return value ? Object.fromEntries(value) : undefined;
}

function assignOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function agentSession(value: HerdrAgentSessionInfo | undefined): Record<string, unknown> | undefined {
  return value && { source: value.source, agent: value.agent, kind: agentSessionKind(value.kind), value: value.value };
}

function paneScroll(value: HerdrPaneScrollInfo | undefined): Record<string, unknown> | undefined {
  return value && {
    offset_from_bottom: value.offsetFromBottom,
    max_offset_from_bottom: value.maxOffsetFromBottom,
    viewport_rows: value.viewportRows,
  };
}

function workspaceWorktree(value: HerdrWorkspaceWorktreeInfo | undefined): Record<string, unknown> | undefined {
  return value && {
    repo_key: value.repoKey,
    repo_name: value.repoName,
    repo_root: value.repoRoot,
    checkout_path: value.checkoutPath,
    is_linked_worktree: value.isLinkedWorktree,
  };
}

function workspace(value: HerdrWorkspaceInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    workspace_id: value.workspaceId,
    number: value.number,
    label: value.label,
    focused: value.focused,
    pane_count: value.paneCount,
    tab_count: value.tabCount,
    active_tab_id: value.activeTabId,
    agent_status: agentStatus(value.agentStatus),
  };
  assignOptional(result, 'tokens', stringRecord(value.tokens));
  assignOptional(result, 'worktree', workspaceWorktree(value.worktree));
  return result;
}

function worktree(value: HerdrWorktreeInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    is_bare: value.isBare,
    is_detached: value.isDetached,
    is_linked_worktree: value.isLinkedWorktree,
    is_prunable: value.isPrunable,
    label: value.label,
    path: value.path,
  };
  assignOptional(result, 'branch', value.branch);
  assignOptional(result, 'open_workspace_id', value.openWorkspaceId);
  return result;
}

function tab(value: HerdrTabInfo): Record<string, unknown> {
  return {
    tab_id: value.tabId,
    workspace_id: value.workspaceId,
    number: value.number,
    label: value.label,
    focused: value.focused,
    pane_count: value.paneCount,
    agent_status: agentStatus(value.agentStatus),
  };
}

function pane(value: HerdrPaneInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    pane_id: value.paneId,
    terminal_id: value.terminalId,
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    focused: value.focused,
    agent_status: agentStatus(value.agentStatus),
    revision: value.revision,
  };
  for (const [key, field] of [
    ['cwd', value.cwd],
    ['foreground_cwd', value.foregroundCwd],
    ['label', value.label],
    ['agent', value.agent],
    ['title', value.title],
    ['terminal_title', value.terminalTitle],
    ['terminal_title_stripped', value.terminalTitleStripped],
    ['display_agent', value.displayAgent],
  ] as const) assignOptional(result, key, field);
  assignOptional(result, 'state_labels', stringRecord(value.stateLabels));
  assignOptional(result, 'tokens', stringRecord(value.tokens));
  assignOptional(result, 'agent_session', agentSession(value.agentSession));
  assignOptional(result, 'scroll', paneScroll(value.scroll));
  return result;
}

function agent(value: HerdrAgentInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    pane_id: value.paneId,
    terminal_id: value.terminalId,
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    focused: value.focused,
    agent_status: agentStatus(value.agentStatus),
    revision: value.revision,
  };
  for (const [key, field] of [
    ['cwd', value.cwd], ['foreground_cwd', value.foregroundCwd], ['agent', value.agent],
    ['name', value.name], ['title', value.title], ['terminal_title', value.terminalTitle],
    ['terminal_title_stripped', value.terminalTitleStripped], ['display_agent', value.displayAgent],
    ['interactive_ready', value.interactiveReady], ['launch_pending', value.launchPending],
    ['screen_detection_skipped', value.screenDetectionSkipped], ['state_change_seq', value.stateChangeSeq],
  ] as const) assignOptional(result, key, field);
  assignOptional(result, 'state_labels', stringRecord(value.stateLabels));
  assignOptional(result, 'tokens', stringRecord(value.tokens));
  assignOptional(result, 'agent_session', agentSession(value.agentSession));
  return result;
}

function rect(value: HerdrPaneLayoutRect): Record<string, unknown> {
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function layout(value: HerdrPaneLayoutSnapshot): Record<string, unknown> {
  return {
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    zoomed: value.zoomed,
    area: rect(value.area),
    focused_pane_id: value.focusedPaneId,
    panes: value.panes.map(item => ({ pane_id: item.paneId, focused: item.focused, rect: rect(item.rect) })),
    splits: value.splits.map(item => ({ id: item.id, direction: splitDirectionString(item.direction), ratio: item.ratio, rect: rect(item.rect) })),
  };
}

function snapshot(value: HerdrSessionSnapshot): Record<string, unknown> {
  return {
    version: value.version,
    protocol: value.protocol,
    focused_workspace_id: value.focusedWorkspaceId,
    focused_tab_id: value.focusedTabId,
    focused_pane_id: value.focusedPaneId,
    agents: value.agents.map(agent),
    workspaces: value.workspaces.map(workspace),
    tabs: value.tabs.map(tab),
    panes: value.panes.map(pane),
    layouts: value.layouts.map(layout),
  };
}

function hostSyncStatus(value: HostSyncStatus): RuntimeHostState['syncStatus'] {
  switch (value) {
    case HostSyncStatus.Idle: return 'idle';
    case HostSyncStatus.Syncing: return 'syncing';
    case HostSyncStatus.Synced: return 'synced';
    case HostSyncStatus.Error: return 'error';
  }
}

function runtimeTransferState(value: TransferState): RuntimeTransferState {
  switch (value) {
    case TransferState.Pending: return 'pending';
    case TransferState.Running: return 'running';
    case TransferState.Completed: return 'completed';
    case TransferState.Failed: return 'failed';
    case TransferState.Cancelled: return 'cancelled';
  }
}

function runtimePreviewState(value: PreviewState): RuntimePreviewState {
  switch (value) {
    case PreviewState.Running: return 'running';
    case PreviewState.Disconnected: return 'disconnected';
    case PreviewState.Stopped: return 'stopped';
  }
}

function runtimeTransferProgress(value: NativeTransferProgress): RuntimeTransferProgress {
  return {
    transferId: value.transferId,
    bytesTransferred: Number(value.bytesTransferred),
    totalBytes: value.totalBytes === undefined ? undefined : Number(value.totalBytes),
    state: runtimeTransferState(value.state),
  };
}

function runtimeRemoteFileKind(value: RemoteFileKind): RuntimeRemoteFileKind {
  switch (value) {
    case RemoteFileKind.File: return 'file';
    case RemoteFileKind.Directory: return 'directory';
    case RemoteFileKind.Symlink: return 'symlink';
    case RemoteFileKind.Other: return 'other';
  }
}

function runtimeDirectory(value: NativeRemoteDirectoryListing): RuntimeRemoteDirectoryListing {
  return {
    path: value.path,
    entries: value.entries.map(runtimeRemoteEntry),
  };
}

function runtimeRemoteEntry(entry: NativeRemoteDirectoryListing['entries'][number]): RuntimeRemoteFileEntry {
  return {
    name: entry.name,
    path: entry.path,
    kind: runtimeRemoteFileKind(entry.kind),
    size: entry.size === undefined ? undefined : Number(entry.size),
    modifiedAt: entry.modifiedAt === undefined ? undefined : Number(entry.modifiedAt),
    permissions: entry.permissions,
  };
}

function runtimeGitStatus(value: NativeGitStatusEntry): RuntimeGitStatusEntry {
  return {
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    path: value.path,
    originalPath: value.originalPath ?? null,
    absolutePath: value.absolutePath,
  };
}

function nativeGitStatus(value: RuntimeGitStatusEntry): NativeGitStatusEntry {
  return {
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    path: value.path,
    originalPath: value.originalPath ?? undefined,
    absolutePath: value.absolutePath,
  };
}

function runtimeGitDiff(value: NativeGitDiff): RuntimeGitDiff {
  const kind = value.kind === GitDiffKind.Binary ? 'binary'
    : value.kind === GitDiffKind.Empty ? 'empty' : 'text';
  const rowKind = (rowKindValue: GitDiffRowKind): RuntimeGitDiffRowKind => {
    switch (rowKindValue) {
      case GitDiffRowKind.Header: return 'header';
      case GitDiffRowKind.Hunk: return 'hunk';
      case GitDiffRowKind.Context: return 'context';
      case GitDiffRowKind.Addition: return 'addition';
      case GitDiffRowKind.Deletion: return 'deletion';
      case GitDiffRowKind.Meta: return 'meta';
    }
  };
  return {
    kind,
    rows: value.rows.map(row => ({
      key: row.key,
      kind: rowKind(row.kind),
      content: row.content,
      marker: row.marker,
      oldLine: row.oldLine ?? null,
      newLine: row.newLine ?? null,
    })),
    truncated: value.truncated,
  };
}

function runtimePreview(value: NativePreviewInfo): RuntimePreviewInfo {
  return {
    id: value.previewId,
    kind: value.kind === PreviewKind.Html ? 'html'
      : value.kind === PreviewKind.RemoteFile ? 'remote-file' : 'web-forward',
    state: runtimePreviewState(value.state),
    url: value.localUrl,
    displayUrl: value.displayUrl,
  };
}

function runtimeDiagnosticOperation(
  value: NativeRuntimeDiagnosticOperation,
): RuntimeDiagnosticOperation {
  switch (value) {
    case NativeRuntimeDiagnosticOperation.SshConnect: return 'ssh-connect';
    case NativeRuntimeDiagnosticOperation.SshReconnect: return 'ssh-reconnect';
    case NativeRuntimeDiagnosticOperation.HostLatencyProbe: return 'host-latency-probe';
    case NativeRuntimeDiagnosticOperation.HerdrRequest: return 'herdr-request';
    case NativeRuntimeDiagnosticOperation.TerminalAttach: return 'terminal-attach';
    case NativeRuntimeDiagnosticOperation.TerminalRecovery: return 'terminal-recovery';
    case NativeRuntimeDiagnosticOperation.EventStreamRecovery: return 'event-stream-recovery';
  }
}

function runtimeDiagnostic(value: NativeRuntimeDiagnostic): RuntimeDiagnostic {
  return {
    operation: runtimeDiagnosticOperation(value.operation),
    durationMs: value.durationMs,
    transportDurationMs: value.transportDurationMs,
    outcome: value.outcome === NativeRuntimeDiagnosticOutcome.Succeeded
      ? 'succeeded'
      : 'failed',
    terminalId: value.terminalId,
    error: value.error,
  };
}

function runtimeHostLatency(
  value: NativeHostLatencyMeasurement,
): RuntimeHostLatencyMeasurement {
  return {
    sshRttMs: value.sshRttMs,
    totalMs: value.totalMs,
    runtimeOverheadMs: value.runtimeOverheadMs,
  };
}

function hostFreshness(value: HostFreshness): RuntimeHostState['freshness'] {
  switch (value) {
    case HostFreshness.Loading: return 'loading';
    case HostFreshness.Fresh: return 'fresh';
    case HostFreshness.Stale: return 'stale';
    case HostFreshness.Unavailable: return 'unavailable';
  }
}

function runtimeHostState(value: HostStateSnapshot): RuntimeHostState {
  return {
    revision: Number(value.revision),
    connectionGeneration: Number(value.connectionGeneration),
    syncGeneration: Number(value.syncGeneration),
    syncStatus: hostSyncStatus(value.syncStatus),
    freshness: hostFreshness(value.freshness),
    error: value.error,
    lastSyncedAtMs: value.lastSyncedAtMs === undefined ? undefined : Number(value.lastSyncedAtMs),
    lastEventAtMs: value.lastEventAtMs === undefined ? undefined : Number(value.lastEventAtMs),
    needsResync: value.needsResync,
    focus: {
      workspaceId: value.focus.workspaceId,
      tabId: value.focus.tabId,
      paneId: value.focus.paneId,
    },
    snapshot: value.snapshot ? snapshot(value.snapshot) : undefined,
  };
}

function apiResult(value: HerdrControlResult): ApiResult {
  switch (value.tag) {
    case HerdrControlResult_Tags.Pong:
      return { type: 'pong', version: value.inner.version, protocol: value.inner.protocol };
    case HerdrControlResult_Tags.SessionSnapshot:
      return { type: 'session_snapshot', snapshot: snapshot(value.inner.snapshot) };
    case HerdrControlResult_Tags.WorkspaceCreated:
      return {
        type: 'workspace_created',
        workspace: workspace(value.inner.workspace),
        tab: tab(value.inner.tab),
        root_pane: pane(value.inner.rootPane),
      };
    case HerdrControlResult_Tags.WorkspaceInfo:
      return { type: 'workspace_info', workspace: workspace(value.inner.workspace) };
    case HerdrControlResult_Tags.TabCreated:
      return { type: 'tab_created', tab: tab(value.inner.tab), root_pane: pane(value.inner.rootPane) };
    case HerdrControlResult_Tags.TabInfo:
      return { type: 'tab_info', tab: tab(value.inner.tab) };
    case HerdrControlResult_Tags.PaneInfo:
      return { type: 'pane_info', pane: pane(value.inner.pane) };
    case HerdrControlResult_Tags.PaneRead:
      return { type: 'pane_read', read: { text: value.inner.read.text } };
    case HerdrControlResult_Tags.AgentStarted:
      return { type: 'agent_started', agent: agent(value.inner.agent), argv: value.inner.argv };
    case HerdrControlResult_Tags.AgentInfo:
      return { type: 'agent_info', agent: agent(value.inner.agent) };
    case HerdrControlResult_Tags.AgentPrompted:
      return { type: 'agent_prompted', agent: agent(value.inner.agent) };
    case HerdrControlResult_Tags.IntegrationInstalled:
      return {
        type: 'integration_install',
        target: value.inner.install.kind === HerdrAgentKind.Claude
          ? 'claude'
          : value.inner.install.kind === HerdrAgentKind.Codex
            ? 'codex'
            : 'opencode',
        details: { messages: [...value.inner.install.messages] },
      };
    case HerdrControlResult_Tags.PaneZoom:
      return { type: 'pane_zoom' };
    case HerdrControlResult_Tags.Ok:
      return { type: 'ok' };
  }
}

function apiEvent(value: HerdrEvent): ApiEvent {
  const { tag: eventTag, inner } = value;
  switch (eventTag) {
    case HerdrEvent_Tags.WorkspaceCreated:
      return { event: 'workspace.created', data: { workspace: workspace(inner.workspace) } };
    case HerdrEvent_Tags.WorkspaceUpdated:
      return { event: 'workspace.updated', data: { workspace: workspace(inner.workspace) } };
    case HerdrEvent_Tags.WorkspaceMetadataUpdated:
      return { event: 'workspace.metadata_updated', data: { workspace: workspace(inner.workspace) } };
    case HerdrEvent_Tags.WorkspaceClosed: {
      const data: Record<string, unknown> = { workspace_id: inner.workspaceId };
      assignOptional(data, 'workspace', inner.workspace && workspace(inner.workspace));
      return { event: 'workspace.closed', data };
    }
    case HerdrEvent_Tags.WorkspaceRenamed:
      return { event: 'workspace.renamed', data: { workspace_id: inner.workspaceId, label: inner.label } };
    case HerdrEvent_Tags.WorkspaceMoved:
      return { event: 'workspace.moved', data: {
        workspace_id: inner.workspaceId,
        insert_index: inner.insertIndex,
        workspaces: inner.workspaces.map(workspace),
      } };
    case HerdrEvent_Tags.WorkspaceReordered: {
      const data: Record<string, unknown> = {
        workspace_ids: inner.workspaceIds,
        workspaces: inner.workspaces.map(workspace),
      };
      assignOptional(data, 'before_workspace_id', inner.beforeWorkspaceId);
      return { event: 'workspace.reordered', data };
    }
    case HerdrEvent_Tags.WorkspaceFocused:
      return { event: 'workspace.focused', data: { workspace_id: inner.workspaceId } };
    case HerdrEvent_Tags.WorktreeCreated:
      return { event: 'worktree.created', data: {
        workspace: workspace(inner.workspace),
        worktree: worktree(inner.worktree),
      } };
    case HerdrEvent_Tags.WorktreeOpened:
      return { event: 'worktree.opened', data: {
        workspace: workspace(inner.workspace),
        worktree: worktree(inner.worktree),
        already_open: inner.alreadyOpen,
      } };
    case HerdrEvent_Tags.WorktreeRemoved: {
      const data: Record<string, unknown> = {
        workspace_id: inner.workspaceId,
        worktree: worktree(inner.worktree),
        forced: inner.forced,
      };
      assignOptional(data, 'workspace', inner.workspace && workspace(inner.workspace));
      return { event: 'worktree.removed', data };
    }
    case HerdrEvent_Tags.TabCreated:
      return { event: 'tab.created', data: { tab: tab(inner.tab) } };
    case HerdrEvent_Tags.TabClosed:
      return { event: 'tab.closed', data: { workspace_id: inner.workspaceId, tab_id: inner.tabId } };
    case HerdrEvent_Tags.TabFocused:
      return { event: 'tab.focused', data: { workspace_id: inner.workspaceId, tab_id: inner.tabId } };
    case HerdrEvent_Tags.TabRenamed:
      return { event: 'tab.renamed', data: {
        workspace_id: inner.workspaceId,
        tab_id: inner.tabId,
        label: inner.label,
      } };
    case HerdrEvent_Tags.TabMoved:
      return { event: 'tab.moved', data: {
        workspace_id: inner.workspaceId,
        tab_id: inner.tabId,
        insert_index: inner.insertIndex,
        tabs: inner.tabs.map(tab),
      } };
    case HerdrEvent_Tags.PaneCreated:
      return { event: 'pane.created', data: { pane: pane(inner.pane) } };
    case HerdrEvent_Tags.PaneUpdated:
      return { event: 'pane.updated', data: { pane: pane(inner.pane) } };
    case HerdrEvent_Tags.PaneClosed:
      return { event: 'pane.closed', data: { workspace_id: inner.workspaceId, pane_id: inner.paneId } };
    case HerdrEvent_Tags.PaneFocused:
      return { event: 'pane.focused', data: { workspace_id: inner.workspaceId, pane_id: inner.paneId } };
    case HerdrEvent_Tags.PaneExited:
      return { event: 'pane.exited', data: { workspace_id: inner.workspaceId, pane_id: inner.paneId } };
    case HerdrEvent_Tags.PaneMoved: {
      const data: Record<string, unknown> = {
        previous_pane_id: inner.previousPaneId,
        previous_workspace_id: inner.previousWorkspaceId,
        previous_tab_id: inner.previousTabId,
        pane: pane(inner.pane),
      };
      assignOptional(data, 'created_workspace', inner.createdWorkspace && workspace(inner.createdWorkspace));
      assignOptional(data, 'created_tab', inner.createdTab && tab(inner.createdTab));
      assignOptional(data, 'closed_workspace_id', inner.closedWorkspaceId);
      assignOptional(data, 'closed_tab_id', inner.closedTabId);
      return { event: 'pane.moved', data };
    }
    case HerdrEvent_Tags.PaneOutputChanged:
      return { event: 'pane.output_changed', data: {
        workspace_id: inner.workspaceId,
        pane_id: inner.paneId,
        revision: inner.revision,
      } };
    case HerdrEvent_Tags.PaneAgentDetected: {
      const data: Record<string, unknown> = {
        workspace_id: inner.workspaceId,
        pane_id: inner.paneId,
        released: inner.released,
      };
      assignOptional(data, 'agent', inner.agent);
      assignOptional(data, 'final_status', inner.finalStatus === undefined ? undefined : agentStatus(inner.finalStatus));
      return { event: 'pane.agent_detected', data };
    }
    case HerdrEvent_Tags.PaneAgentStatusChanged: {
      const data: Record<string, unknown> = {
        workspace_id: inner.workspaceId,
        pane_id: inner.paneId,
        agent_status: agentStatus(inner.agentStatus),
      };
      assignOptional(data, 'agent', inner.agent);
      assignOptional(data, 'title', inner.title);
      assignOptional(data, 'display_agent', inner.displayAgent);
      assignOptional(data, 'state_labels', stringRecord(inner.stateLabels));
      return { event: 'pane.agent_status_changed', data };
    }
    case HerdrEvent_Tags.LayoutUpdated:
      return { event: 'layout.updated', data: { layout: layout(inner.layout) } };
    case HerdrEvent_Tags.ProtocolUnknown:
      return { event: 'protocol.unknown', data: { raw_event: inner.rawEvent } };
    case HerdrEvent_Tags.ProtocolInvalid:
      return { event: 'protocol.invalid', data: { raw_event: inner.rawEvent, reason: inner.reason } };
  }
}

function controlEvent(terminalId: string, event: HerdrTerminalControlEvent): BridgeEvent {
  switch (event.tag) {
    case HerdrTerminalControlEvent_Tags.Closed:
      return { type: 'closed', terminalId, text: event.inner.reason };
    case HerdrTerminalControlEvent_Tags.Notify:
      return {
        type: 'notify',
        terminalId,
        text: event.inner.text,
        body: event.inner.body,
        kind: terminalNotificationKind(event.inner.kind),
      };
    case HerdrTerminalControlEvent_Tags.Clipboard:
      return { type: 'clipboard', terminalId, text: event.inner.text };
    case HerdrTerminalControlEvent_Tags.Title:
      return { type: 'title', terminalId, text: event.inner.title };
    case HerdrTerminalControlEvent_Tags.ReloadSoundConfig:
      return { type: 'reload_sound_config', terminalId };
    case HerdrTerminalControlEvent_Tags.MouseCapture:
      return { type: 'mouse_capture', terminalId, flag: event.inner.enabled };
    case HerdrTerminalControlEvent_Tags.KittyKeyboardReportAll:
      return { type: 'kitty_keyboard_report_all', terminalId, flag: event.inner.enabled };
    case HerdrTerminalControlEvent_Tags.PrefixInputSource:
      return { type: 'prefix_input_source', terminalId, flag: event.inner.enabled };
    case HerdrTerminalControlEvent_Tags.TerminalBell:
      return { type: 'terminal_bell', terminalId, count: event.inner.count };
    case HerdrTerminalControlEvent_Tags.Ignored:
      return { type: 'ignored', terminalId };
  }
}

const herdrTerminalEventSink: HerdrTerminalEventSink = {
  terminalFrame(clientKey, terminalId, sequence, width, height, full, base64Bytes): void {
    const handler = bridgeHandler(clientKey, terminalId);
    if (!handler) return;
    const inboundTraceCookie = terminalInboundTrace()?.jsReceived() ?? null;
    terminalInboundTrace()?.decodeComplete(inboundTraceCookie);
    handler({
      type: 'terminal',
      terminalId,
      seq: Number(sequence),
      width,
      height,
      full,
      bytes: base64Bytes,
      final: true,
      inboundTraceCookie,
    });
  },
  graphicsFrame(clientKey, terminalId, bytes): void {
    bridgeHandler(clientKey, terminalId)?.({
      type: 'graphics',
      terminalId,
      bytes,
    });
  },
  control(clientKey, terminalId, event): void {
    const handler = bridgeHandler(clientKey, terminalId);
    handler?.(controlEvent(terminalId, event));
    if (event.tag === HerdrTerminalControlEvent_Tags.Closed) removeBridgeHandler(clientKey, terminalId);
  },
};

const herdrEventSink: HerdrEventSink = {
  event(clientKey, event): void {
    eventHandlers.get(clientKey)?.({ type: 'event', event: apiEvent(event) });
  },
  closed(clientKey, reason): void {
    const handler = eventHandlers.get(clientKey);
    eventHandlers.delete(clientKey);
    handler?.({ type: 'closed', reason });
  },
};

const hostRuntimeEventSink = {
  event(event: HostRuntimeEvent): void {
    const { tag, inner } = event;
    if (tag === HostRuntimeEvent_Tags.SshShellData) {
      runtimeSshShellHandlers.get(inner.runtimeId)?.get(inner.terminalId)?.data(inner.bytes);
      return;
    }
    if (tag === HostRuntimeEvent_Tags.SshShellClosed) {
      const handlers = runtimeSshShellHandlers.get(inner.runtimeId);
      const shell = handlers?.get(inner.terminalId);
      handlers?.delete(inner.terminalId);
      if (handlers?.size === 0) runtimeSshShellHandlers.delete(inner.runtimeId);
      shell?.closed?.(inner.reason);
      return;
    }
    const handler = runtimeHandlers.get(inner.runtimeId);
    if (!handler) return;
    switch (tag) {
      case HostRuntimeEvent_Tags.ConnectionStateChanged:
        handler({
          type: 'connection-state',
          state: runtimeConnectionState(inner.status.state),
          generation: Number(inner.status.generation),
          reconnectAttempt: inner.status.reconnectAttempt,
          error: inner.status.error,
        });
        break;
      case HostRuntimeEvent_Tags.ReconnectScheduled:
        handler({ type: 'reconnect-scheduled', attempt: inner.attempt, delayMs: Number(inner.delayMs), reason: inner.reason });
        break;
      case HostRuntimeEvent_Tags.Reconnected:
        handler({ type: 'reconnected', generation: Number(inner.generation), restoredTerminals: inner.restoredTerminals });
        break;
      case HostRuntimeEvent_Tags.TerminalStateChanged:
        handler({
          type: 'terminal-state',
          terminalId: inner.terminalId,
          state: runtimeTerminalState(inner.state),
          reconnectAttempt: Number(inner.reconnectAttempt),
          retrying: inner.retrying,
          error: inner.error,
        });
        break;
      case HostRuntimeEvent_Tags.HostStateChanged:
        handler({
          type: 'host-state',
          state: runtimeHostState(inner.state),
          changedAgentPaneIds: [...inner.changedAgentPaneIds],
        });
        break;
      case HostRuntimeEvent_Tags.EventSubscriptionClosed:
        handler({ type: 'event-stream-closed', reason: inner.reason });
        break;
      case HostRuntimeEvent_Tags.EventSubscriptionRestored:
        handler({ type: 'event-stream-restored', generation: Number(inner.generation) });
        break;
      case HostRuntimeEvent_Tags.TransferProgressChanged:
        handler({ type: 'transfer-progress', progress: runtimeTransferProgress(inner.progress) });
        break;
      case HostRuntimeEvent_Tags.PreviewStateChanged:
        handler({
          type: 'preview-state',
          previewId: inner.previewId,
          state: runtimePreviewState(inner.state),
          error: inner.error,
        });
        break;
      case HostRuntimeEvent_Tags.Diagnostic:
        handler({ type: 'diagnostic', diagnostic: runtimeDiagnostic(inner.diagnostic) });
        break;
      case HostRuntimeEvent_Tags.FatalError:
        handler({ type: 'fatal-error', message: inner.message });
        break;
    }
  },
};

const agentTranscriptEventSink = {
  event(event: AgentTranscriptEvent): void {
    const handlers = agentTranscriptHandlers.get(event.runtimeId);
    const handler = handlers?.get(event.key);
    handler?.(nativeAgentUpdate(event));
    const closed = event.update.deltas.some(delta => (
      delta.tag === AgentTranscriptDelta_Tags.StatusChanged
      && delta.inner.status === AgentTranscriptStatus.Closed
    ));
    if (closed) handlers?.delete(event.key);
  },
};

setHerdrTerminalEventSink(herdrTerminalEventSink);
setHerdrEventSink(herdrEventSink);
setHostRuntimeEventSink(hostRuntimeEventSink);
setAgentTranscriptEventSink(agentTranscriptEventSink);

export class NativeHostRuntime {
  readonly runtimeId: string;

  constructor(
    private readonly runtime: HostRuntimeLike,
    lifecycleHandler?: (event: RuntimeLifecycleEvent) => void,
  ) {
    this.runtimeId = runtime.runtimeId();
    if (lifecycleHandler) runtimeHandlers.set(this.runtimeId, lifecycleHandler);
  }

  async connect(): Promise<void> {
    try {
      await this.runtime.connect();
    } catch (error) {
      const normalized = hostRuntimeError(error);
      console.error('[WhipSsh] host runtime connect failed', {
        runtimeId: this.runtimeId,
        tag: normalized.nativeTag || 'Unknown',
        message: normalized.message,
      });
      throw normalized;
    }
  }

  async createTabWithLaunch(
    workspaceId: string,
    label: string,
    launch: RuntimeTabLaunch,
  ): Promise<ApiResult> {
    const nativeLaunch = launch.type === 'shell'
      ? HerdrTabLaunch.Shell.new()
      : launch.type === 'agent'
        ? HerdrTabLaunch.Agent.new({ kind: runtimeAgentKind(launch.kind), args: launch.args || [] })
        : HerdrTabLaunch.Command.new({ command: launch.command });
    const outcome = await this.runtime.createTabWithLaunch(workspaceId, label, nativeLaunch);
    const projected: ApiResult = {
      type: 'tab_created',
      tab: tab(outcome.inner.tab),
      root_pane: pane(outcome.inner.rootPane),
    };
    if (outcome.tag === HerdrTabLaunchResult_Tags.LaunchFailed) {
      const normalized = new Error(outcome.inner.failure.message) as RuntimeTabLaunchFailure;
      normalized.name = 'RuntimeTabLaunchError';
      normalized.code = 'TAB_LAUNCH_FAILED';
      normalized.created = projected;
      normalized.launchType = outcome.inner.stage === HerdrTabLaunchStage.AgentStart
        ? 'agent'
        : 'command';
      normalized.nativeFailure = outcome.inner.failure;
      throw normalized;
    }
    return projected;
  }

  submitPastes(paneId: string, parts: string[]): Promise<void> {
    return this.runtime.submitPastes(paneId, parts);
  }

  async startHerdrServer(): Promise<void> {
    try {
      await this.runtime.startHerdrServer();
    } catch (error) {
      throw hostRuntimeError(error);
    }
  }

  async agentIntegrationStatus(kind: RuntimeAgentKind): Promise<RuntimeAgentIntegrationStatus> {
    const status = await this.runtime.agentIntegrationStatus(runtimeAgentKind(kind));
    switch (status) {
      case AgentIntegrationStatus.NotInstalled: return 'not-installed';
      case AgentIntegrationStatus.Current: return 'current';
      case AgentIntegrationStatus.Outdated: return 'outdated';
      case AgentIntegrationStatus.NeedsRepair: return 'needs-repair';
      default: return 'unknown';
    }
  }

  async installAgentIntegration(kind: RuntimeAgentKind): Promise<{
    kind: RuntimeAgentKind;
    messages: string[];
  }> {
    const installed = await this.runtime.installAgentIntegration(runtimeAgentKind(kind));
    return { kind, messages: [...installed.messages] };
  }

  async disconnect(): Promise<void> {
    runtimeHandlers.delete(this.runtimeId);
    agentTranscriptHandlers.delete(this.runtimeId);
    runtimeSshShellHandlers.delete(this.runtimeId);
    eventHandlers.delete(this.runtimeId);
    bridgeHandlers.delete(this.runtimeId);
    await this.runtime.disconnect();
  }

  recover(immediate: boolean, reason: string): Promise<void> {
    return this.runtime.recover(immediate, reason);
  }

  status() { return this.runtime.status(); }

  hostState(): RuntimeHostState { return runtimeHostState(this.runtime.hostState()); }

  async refreshState(): Promise<RuntimeHostState> {
    return runtimeHostState(await this.runtime.refreshState());
  }

  openAgentSession(
    agentKind: 'codex' | 'opencode',
    terminalId: string,
    sessionId: string,
    cacheBlob?: ArrayBuffer,
    handler?: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState } {
    const result = this.runtime.openAgentSession(
      agentKind === 'opencode' ? AgentTranscriptKind.OpenCode : AgentTranscriptKind.Codex,
      terminalId,
      sessionId,
      cacheBlob,
    );
    if (handler) {
      let handlers = agentTranscriptHandlers.get(this.runtimeId);
      if (!handlers) {
        handlers = new Map();
        agentTranscriptHandlers.set(this.runtimeId, handlers);
      }
      handlers.set(result.key, handler);
    }
    return { key: result.key, state: nativeAgentTranscript(result.state) };
  }

  bindAgentSession(
    agentKind: 'codex' | 'opencode',
    terminalId: string,
    sessionId: string,
    handler?: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState } {
    const result = this.runtime.bindAgentSession(
      agentKind === 'opencode' ? AgentTranscriptKind.OpenCode : AgentTranscriptKind.Codex,
      terminalId,
      sessionId,
    );
    if (handler) {
      let handlers = agentTranscriptHandlers.get(this.runtimeId);
      if (!handlers) {
        handlers = new Map();
        agentTranscriptHandlers.set(this.runtimeId, handlers);
      }
      handlers.set(result.key, handler);
    }
    return { key: result.key, state: nativeAgentTranscript(result.state) };
  }

  startAgentSession(
    terminalId: string,
    key: string,
    cacheBlob?: ArrayBuffer,
  ): NativeAgentTranscriptState {
    return nativeAgentTranscript(this.runtime.startAgentSession(terminalId, key, cacheBlob));
  }

  agentTranscript(key: string): NativeAgentTranscriptState {
    return nativeAgentTranscript(this.runtime.agentTranscript(key));
  }

  closeAgentSession(key: string): void {
    agentTranscriptHandlers.get(this.runtimeId)?.delete(key);
    this.runtime.closeAgentSession(key);
  }

  closeAgentTerminal(terminalId: string): string | undefined {
    const released = this.runtime.closeAgentTerminal(terminalId);
    if (released) agentTranscriptHandlers.get(this.runtimeId)?.delete(released);
    return released;
  }

  confirmAgentTranscriptCache(confirmationToken: string): boolean {
    return this.runtime.confirmAgentTranscriptCache(confirmationToken);
  }

  resolvedSocketPath(): string | undefined { return this.runtime.resolvedSocketPath(); }

  resolveHerdrSocketPath(): Promise<string> { return this.runtime.resolveControlSocket(); }

  async requestHerdrApi(request: ApiRequest): Promise<ApiResult> {
    try {
      return apiResult(await this.runtime.controlRequest(controlRequest(request)));
    } catch (error) {
      throw controlError(error);
    }
  }

  async startHerdrBridge(
    terminalId: string,
    takeover: boolean,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    handler: BridgeHandler,
  ): Promise<void> {
    setBridgeHandler(this.runtimeId, terminalId, handler);
    try {
      await this.runtime.openTerminal(terminalId, takeover, columns, rows, cellWidthPx, cellHeightPx);
    } catch (error) {
      removeBridgeHandler(this.runtimeId, terminalId);
      throw bridgeError(error);
    }
  }

  herdrBridgeInput(terminalId: string, text: string): Promise<void> {
    try { this.runtime.terminalInput(terminalId, text); return Promise.resolve(); }
    catch (error) { return Promise.reject(bridgeError(error)); }
  }

  herdrBridgeResize(terminalId: string, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number): Promise<void> {
    try { this.runtime.resizeTerminal(terminalId, columns, rows, cellWidthPx, cellHeightPx); return Promise.resolve(); }
    catch (error) { return Promise.reject(bridgeError(error)); }
  }

  herdrBridgeScroll(terminalId: string, up: boolean, lines: number, column?: number, row?: number, modifiers = 0): Promise<void> {
    try { this.runtime.scrollTerminal(terminalId, up, lines, column, row, modifiers); return Promise.resolve(); }
    catch (error) { return Promise.reject(bridgeError(error)); }
  }

  closeHerdrBridge(terminalId: string): void {
    removeBridgeHandler(this.runtimeId, terminalId);
    this.runtime.closeTerminal(terminalId);
  }

  closeAllHerdrBridges(): void {
    bridgeHandlers.delete(this.runtimeId);
    this.runtime.closeAllTerminals();
  }

  hasHerdrBridge(terminalId: string): boolean { return this.runtime.hasTerminal(terminalId); }

  isHerdrBridgeOpening(terminalId: string): boolean { return this.runtime.isTerminalOpening(terminalId); }

  async openSshShell(
    terminalId: string,
    columns: number,
    rows: number,
    handler: RuntimeSshShellHandler,
  ): Promise<void> {
    let handlers = runtimeSshShellHandlers.get(this.runtimeId);
    if (!handlers) {
      handlers = new Map();
      runtimeSshShellHandlers.set(this.runtimeId, handlers);
    }
    handlers.set(terminalId, handler);
    try {
      await this.runtime.openSshShell(terminalId, columns, rows);
    } catch (error) {
      handlers.delete(terminalId);
      if (handlers.size === 0) runtimeSshShellHandlers.delete(this.runtimeId);
      throw error;
    }
  }

  sshShellInput(terminalId: string, bytes: ArrayBuffer): void {
    this.runtime.sshShellInput(terminalId, bytes);
  }

  resizeSshShell(terminalId: string, columns: number, rows: number): void {
    this.runtime.resizeSshShell(terminalId, columns, rows);
  }

  closeSshShell(terminalId: string): void {
    runtimeSshShellHandlers.get(this.runtimeId)?.delete(terminalId);
    this.runtime.closeSshShell(terminalId);
  }

  hasSshShell(terminalId: string): boolean { return this.runtime.hasSshShell(terminalId); }

  execute(command: string): Promise<string> { return this.runtime.execute(command); }

  remoteHome(): Promise<string> { return this.runtime.remoteHome(); }

  async measureHostLatency(): Promise<RuntimeHostLatencyMeasurement> {
    return runtimeHostLatency(await this.runtime.measureHostLatency());
  }

  async listDirectory(path?: string): Promise<RuntimeRemoteDirectoryListing> {
    return runtimeDirectory(await this.runtime.listDirectory(path));
  }

  async statRemotePath(path: string): Promise<RuntimeRemoteFileEntry> {
    return runtimeRemoteEntry(await this.runtime.statRemotePath(path));
  }

  readRemoteText(path: string, maxBytes?: number): Promise<string> {
    return this.runtime.readRemoteText(path, maxBytes === undefined ? undefined : BigInt(maxBytes));
  }

  createRemoteDirectory(path: string): Promise<void> {
    return this.runtime.createRemoteDirectory(path);
  }

  renameRemotePath(from: string, to: string): Promise<void> {
    return this.runtime.renameRemotePath(from, to);
  }

  removeRemotePath(path: string, directory: boolean): Promise<void> {
    return this.runtime.removeRemotePath(path, directory);
  }

  private transfer(id: string): RuntimeTransfer {
    return {
      id,
      result: this.runtime.awaitTransfer(id).then((result: NativeTransferResult) => ({
        transferId: result.transferId,
        localPath: result.localPath,
        remotePath: result.remotePath,
      })).catch(error => {
        throw hostRuntimeError(error);
      }),
    };
  }

  startUpload(localPath: string, remoteDirectory: string): RuntimeTransfer {
    return this.transfer(this.runtime.startUpload(localPath, remoteDirectory));
  }

  startAttachmentUpload(localPath: string): RuntimeTransfer {
    return this.transfer(this.runtime.startAttachmentUpload(localPath));
  }

  startDownload(remotePath: string, localDirectory: string): RuntimeTransfer {
    return this.transfer(this.runtime.startDownload(remotePath, localDirectory));
  }

  transferProgress(transferId: string): RuntimeTransferProgress | undefined {
    const progress = this.runtime.transferProgress(transferId);
    return progress && runtimeTransferProgress(progress);
  }

  cancelTransfer(transferId: string): boolean { return this.runtime.cancelTransfer(transferId); }

  async discoverGitRepository(path: string): Promise<RuntimeGitRepository | null> {
    return await this.runtime.discoverGitRepository(path) ?? null;
  }

  async gitStatus(root: string): Promise<RuntimeGitStatusEntry[]> {
    return (await this.runtime.gitStatus(root)).map(runtimeGitStatus);
  }

  async gitDiff(repository: RuntimeGitRepository, status: RuntimeGitStatusEntry): Promise<RuntimeGitDiff> {
    return runtimeGitDiff(await this.runtime.gitDiff(
      repository as NativeGitRepository,
      nativeGitStatus(status),
    ));
  }

  async startWebPreview(remoteUrl: string): Promise<RuntimePreviewInfo> {
    return runtimePreview(await this.runtime.startWebPreview(remoteUrl));
  }

  async startHtmlPreview(remotePath: string): Promise<RuntimePreviewInfo> {
    return runtimePreview(await this.runtime.startHtmlPreview(remotePath));
  }

  async startRemoteFilePreview(remotePath: string): Promise<RuntimePreviewInfo> {
    return runtimePreview(await this.runtime.startRemoteFilePreview(remotePath));
  }

  stopPreview(previewId: string): Promise<void> { return this.runtime.stopPreview(previewId); }

}

const nativeClient = {
  ...sshNativeClient,
  setTrustedHostKeys(entries: Array<{
    host: string;
    port: number;
    keyType: string;
    publicKey: string;
  }>): void {
    setTrustedHostKeysRust(entries);
  },
  createHostRuntime(config: RuntimeConfig, handler?: (event: RuntimeLifecycleEvent) => void): NativeHostRuntime {
    const runtime = createHostRuntimeRust({
      runtimeId: config.runtimeId,
      ssh: runtimeSshConfig(config.ssh),
      jumpHosts: config.jumpHosts.map(runtimeSshConfig),
      sessionName: config.sessionName,
      herdrCommand: config.herdrCommand,
      socketPath: config.socketPath,
      cachedSocketPath: config.cachedSocketPath,
    });
    return new NativeHostRuntime(runtime, handler);
  },
  async pairHost(code: string, publicKey: string, deviceName: string): Promise<unknown> {
    const response = JSON.parse(await pairHostRust(code, publicKey, deviceName)) as PairingResponse;
    if (!response.ok) throw new Error(response.error || 'WP4 pairing failed');
    return response.value;
  },

  async prepareHerdrBridge(
    clientKey: string,
    socketPath: string,
    protocol: number,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ): Promise<void> {
    try {
      await prepareHerdrTerminalBridge(
        clientKey,
        socketPath,
        protocol,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      );
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async requestHerdrApi(
    clientKey: string,
    socketPath: string,
    request: ApiRequest,
  ): Promise<ApiResult> {
    try {
      return apiResult(await herdrControlRequest(clientKey, socketPath, controlRequest(request)));
    } catch (error) {
      throw controlError(error);
    }
  },

  async startHerdrEventStream(
    clientKey: string,
    socketPath: string,
    protocol: number,
    paneIds: string[],
    handler: EventHandler,
  ): Promise<void> {
    eventHandlers.set(clientKey, handler);
    try {
      await startHerdrEventSubscription(clientKey, socketPath, protocol, paneIds);
    } catch (error) {
      eventHandlers.delete(clientKey);
      throw eventError(error);
    }
  },

  closeHerdrEventStream(clientKey: string): void {
    eventHandlers.delete(clientKey);
    closeHerdrEventSubscription(clientKey);
  },

  async startHerdrBridge(
    clientKey: string,
    socketPath: string,
    protocol: number,
    terminalId: string,
    takeover: boolean,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    terminalAttachLaunchMode: number,
    handler: BridgeHandler,
  ): Promise<void> {
    setBridgeHandler(clientKey, terminalId, handler);
    try {
      await startHerdrTerminalBridge(
        clientKey,
        socketPath,
        protocol,
        terminalId,
        takeover,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
        nativeTerminalAttachLaunchMode(terminalAttachLaunchMode),
      );
    } catch (error) {
      removeBridgeHandler(clientKey, terminalId);
      throw bridgeError(error);
    }
  },

  async herdrBridgeInput(clientKey: string, terminalId: string, text: string): Promise<void> {
    try {
      herdrTerminalInput(clientKey, terminalId, text);
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async herdrBridgeResize(
    clientKey: string,
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ): Promise<void> {
    try {
      herdrTerminalResize(
        clientKey,
        terminalId,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      );
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async herdrBridgeScroll(
    clientKey: string,
    terminalId: string,
    up: boolean,
    lines: number,
    column: number | undefined,
    row: number | undefined,
    modifiers: number,
  ): Promise<void> {
    try {
      herdrTerminalScroll(clientKey, terminalId, up, lines, column, row, modifiers);
    } catch (error) {
      throw bridgeError(error);
    }
  },

  closeHerdrBridge(clientKey: string, terminalId: string): void {
    removeBridgeHandler(clientKey, terminalId);
    closeHerdrTerminalBridge(clientKey, terminalId);
  },

  closeAllHerdrBridges(clientKey: string): void {
    bridgeHandlers.delete(clientKey);
    closeAllHerdrTerminalBridges(clientKey);
  },
};

export default nativeClient;
