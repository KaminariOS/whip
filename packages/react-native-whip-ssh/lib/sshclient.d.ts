import BaseSSHClient, { type CallbackFunction } from './base-sshclient';

export * from './base-sshclient';

export interface HerdrBridgeEvent {
  type:
    | 'terminal'
    | 'closed'
    | 'graphics'
    | 'notify'
    | 'clipboard'
    | 'title'
    | 'reload_sound_config'
    | 'mouse_capture'
    | 'kitty_keyboard_report_all'
    | 'prefix_input_source'
    | 'terminal_bell'
    | 'ignored';
  terminalId?: string;
  seq?: number;
  width?: number;
  height?: number;
  full?: boolean;
  /** A view into the received frame; honor its byteOffset and byteLength. */
  bytes?: string | ArrayBuffer | ArrayBufferView;
  final?: boolean;
  text?: string;
  body?: string;
  flag?: boolean;
  kind?: number;
  count?: number;
  /** Perfetto-only correlation cookie; absent when Android tracing is disabled. */
  inboundTraceCookie?: number | null;
}

export interface HerdrCommandStreamEvent {
  data?: string;
  closed?: boolean;
  error?: string;
  reason?: string;
}

export type HerdrEventStreamEvent =
  | { type: 'event'; event: { event: string; data: Record<string, unknown> } }
  | { type: 'closed'; reason?: string };

export type HostRuntimeLifecycleEvent =
  | { type: 'connection-state'; state: string; generation: number; reconnectAttempt: number; error?: string }
  | { type: 'reconnect-scheduled'; attempt: number; delayMs: number; reason: string }
  | { type: 'reconnected'; generation: number; restoredTerminals: number }
  | { type: 'terminal-state'; terminalId: string; state: string; reconnectAttempt: number; retrying: boolean; error?: string }
  | { type: 'host-state'; state: HostRuntimeState; changedAgentPaneIds: string[] }
  | { type: 'event-stream-closed'; reason: string }
  | { type: 'event-stream-restored'; generation: number }
  | { type: 'transfer-progress'; progress: RuntimeTransferProgress }
  | { type: 'preview-state'; previewId: string; state: RuntimePreviewState; error?: string }
  | { type: 'fatal-error'; message: string };

export type RuntimeTransferState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RuntimePreviewState = 'running' | 'disconnected' | 'stopped';
export interface RuntimeTransferProgress { transferId: string; bytesTransferred: number; totalBytes?: number; state: RuntimeTransferState }
export interface RuntimeTransferResult { transferId: string; localPath?: string; remotePath?: string }
export interface RuntimeTransfer { id: string; result: Promise<RuntimeTransferResult> }
export interface RuntimeRemoteFileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
  modifiedAt?: number;
  permissions?: number;
}
export interface RuntimeRemoteDirectoryListing { path: string; entries: RuntimeRemoteFileEntry[] }
export interface RuntimeGitRepository { root: string; hasHead: boolean }
export interface RuntimeGitStatusEntry { indexStatus: string; worktreeStatus: string; path: string; originalPath: string | null; absolutePath: string }
export interface RuntimeGitDiff {
  kind: 'text' | 'binary' | 'empty';
  rows: Array<{ key: string; kind: 'header' | 'hunk' | 'context' | 'addition' | 'deletion' | 'meta'; content: string; marker: string; oldLine: number | null; newLine: number | null }>;
  truncated: boolean;
}
export interface RuntimePreviewInfo { id: string; kind: 'web-forward' | 'html' | 'remote-file'; state: RuntimePreviewState; url: string; displayUrl?: string }

export interface HostRuntimeState {
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
}

export type NativeAgentTranscriptPart =
  | { type: 'text'; id: string; text: string; timestamp?: number }
  | { type: 'reasoning'; id: string; text: string; timestamp?: number }
  | { type: 'plan'; id: string; text: string; timestamp?: number }
  | { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string; timestamp?: number }
  | { type: 'tool'; id: string; callId: string; tool: string; timestamp?: number; state: {
      status: 'pending' | 'running' | 'completed' | 'error';
      input: Record<string, string | number | boolean>;
      output?: string; error?: string; title?: string;
      startedAt?: number; completedAt?: number; exitCode?: number;
      files: Array<{ file: string; patch?: string; before?: string; after?: string; additions?: number; deletions?: number }>;
    } };

export interface NativeAgentTranscriptState {
  sessionId: string;
  agent: 'codex' | 'opencode';
  revision: number;
  status: 'loading' | 'live' | 'stale' | 'unavailable' | 'error' | 'closed';
  info?: { id: string; title?: string; directory?: string; createdAt?: number; updatedAt?: number };
  messages: Array<{ id: string; role: 'user' | 'assistant'; parentId?: string; createdAt?: number; completedAt?: number; error?: string; parts: NativeAgentTranscriptPart[]; diffs: Array<{ file: string; patch?: string; before?: string; after?: string; additions?: number; deletions?: number }> }>;
  turns: Array<{ id: string; userMessageId?: string; assistantMessageIds: string[]; status: 'idle' | 'working' | 'interrupted' | 'error'; startedAt?: number; completedAt?: number; diffs: Array<{ file: string; patch?: string; before?: string; after?: string; additions?: number; deletions?: number }> }>;
  error?: string;
}

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

export interface NativeAgentTranscriptUpdate {
  key: string;
  revision: number;
  deltas: NativeAgentTranscriptDelta[];
  cacheWrite?: {
    namespace: string;
    key: string;
    blob: ArrayBuffer;
    confirmationToken: string;
  };
}

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

export interface HostRuntimeConnection {
  readonly runtimeId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  recover(immediate: boolean, reason: string): Promise<void>;
  hostState(): HostRuntimeState;
  refreshState(): Promise<HostRuntimeState>;
  openAgentSession(agent: 'codex' | 'opencode', terminalId: string, sessionId: string, cacheBlob?: ArrayBuffer, handler?: (event: NativeAgentTranscriptUpdate) => void): { key: string; state: NativeAgentTranscriptState };
  bindAgentSession(agent: 'codex' | 'opencode', terminalId: string, sessionId: string, handler?: (event: NativeAgentTranscriptUpdate) => void): { key: string; state: NativeAgentTranscriptState };
  startAgentSession(terminalId: string, key: string, cacheBlob?: ArrayBuffer): NativeAgentTranscriptState;
  agentTranscript(key: string): NativeAgentTranscriptState;
  closeAgentSession(key: string): void;
  closeAgentTerminal(terminalId: string): string | undefined;
  confirmAgentTranscriptCache(confirmationToken: string): boolean;
  createTabWithLaunch(workspaceId: string, label: string, launch: RuntimeTabLaunch): Promise<Record<string, unknown>>;
  agentIntegrationStatus(kind: RuntimeAgentKind): Promise<RuntimeAgentIntegrationStatus>;
  installAgentIntegration(kind: RuntimeAgentKind): Promise<{ kind: RuntimeAgentKind; messages: string[] }>;
  requestHerdrApi(request: { method: string; params: object }): Promise<Record<string, unknown>>;
  startHerdrBridge(terminalId: string, takeover: boolean, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number, handler: (event: HerdrBridgeEvent) => void): Promise<void>;
  herdrBridgeInput(terminalId: string, text: string): Promise<void>;
  herdrBridgeResize(terminalId: string, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number): Promise<void>;
  herdrBridgeScroll(terminalId: string, up: boolean, lines: number, column?: number, row?: number, modifiers?: number): Promise<void>;
  closeHerdrBridge(terminalId: string): void;
  closeAllHerdrBridges(): void;
  hasHerdrBridge(terminalId: string): boolean;
  isHerdrBridgeOpening(terminalId: string): boolean;
  openSshShell(terminalId: string, columns: number, rows: number, handler: {
    data(bytes: ArrayBuffer): void;
    closed?(reason: string): void;
  }): Promise<void>;
  sshShellInput(terminalId: string, bytes: ArrayBuffer): void;
  resizeSshShell(terminalId: string, columns: number, rows: number): void;
  closeSshShell(terminalId: string): void;
  hasSshShell(terminalId: string): boolean;
  execute(command: string): Promise<string>;
  remoteHome(): Promise<string>;
  measureHostLatency(): Promise<number>;
  listDirectory(path?: string): Promise<RuntimeRemoteDirectoryListing>;
  statRemotePath(path: string): Promise<RuntimeRemoteFileEntry>;
  readRemoteText(path: string, maxBytes?: number): Promise<string>;
  createRemoteDirectory(path: string): Promise<void>;
  renameRemotePath(from: string, to: string): Promise<void>;
  removeRemotePath(path: string, directory: boolean): Promise<void>;
  startUpload(localPath: string, remoteDirectory: string): RuntimeTransfer;
  startAttachmentUpload(localPath: string): RuntimeTransfer;
  startDownload(remotePath: string, localDirectory: string): RuntimeTransfer;
  transferProgress(transferId: string): RuntimeTransferProgress | undefined;
  cancelTransfer(transferId: string): boolean;
  discoverGitRepository(path: string): Promise<RuntimeGitRepository | null>;
  gitStatus(root: string): Promise<RuntimeGitStatusEntry[]>;
  gitDiff(repository: RuntimeGitRepository, status: RuntimeGitStatusEntry): Promise<RuntimeGitDiff>;
  startWebPreview(remoteUrl: string): Promise<RuntimePreviewInfo>;
  startHtmlPreview(remotePath: string): Promise<RuntimePreviewInfo>;
  startRemoteFilePreview(remotePath: string): Promise<RuntimePreviewInfo>;
  stopPreview(previewId: string): Promise<void>;
  resolvedSocketPath(): string | undefined;
  resolveHerdrSocketPath(): Promise<string>;
}

export interface HerdrApiRequest {
  method: string;
  params: object;
}

export interface PairHostResult {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshHostFingerprint: string;
  sshHostKeyType: string;
  sshHostPublicKey: string;
  keyFingerprint?: string;
  alreadyPresent: boolean;
}

/** Whip-specific methods augment the single SSH facade without subclassing it. */
export interface WhipSSHClientExtensions {
  prepareHerdrBridge(
    command: string,
    protocol: number,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    callback?: CallbackFunction<void>,
  ): Promise<void>;
  startHerdrBridge(
    socketPath: string,
    protocol: number,
    terminalId: string,
    takeover: boolean,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    handler: (event: HerdrBridgeEvent) => void,
    terminalAttachLaunchMode?: 1 | 2,
    callback?: CallbackFunction<void>,
  ): Promise<void>;
  herdrBridgeInput(terminalId: string, text: string): Promise<void>;
  herdrBridgeResize(
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx?: number,
    cellHeightPx?: number,
  ): Promise<void>;
  herdrBridgeScroll(
    terminalId: string,
    direction: 'up' | 'down',
    lines: number,
    column?: number,
    row?: number,
    modifiers?: number,
  ): Promise<void>;
  closeHerdrBridge(terminalId: string): void;
  closeAllHerdrBridges(): void;
  startHerdrEventStream(
    socketPath: string,
    protocol: number,
    paneIds: string[],
    handler: (event: HerdrEventStreamEvent) => void,
    callback?: CallbackFunction<void>,
  ): Promise<void>;
  closeHerdrEventStream(): void;
  requestHerdrApi(socketPath: string, request: HerdrApiRequest): Promise<unknown>;
  startHerdrCommandStream(
    command: string,
    handler: (event: HerdrCommandStreamEvent) => void,
    callback?: CallbackFunction<void>,
  ): Promise<void>;
  writeHerdrCommandStream(value: string): Promise<void>;
  closeHerdrCommandStream(): void;
  disconnect(): void;
}

/** Declaration merging models prototype augmentation; the runtime has one class. */
interface SSHClient extends BaseSSHClient, WhipSSHClientExtensions {}

declare class SSHClient {
  static addNetworkChangeListener(handler: () => void): { remove: () => void };
  static setKnownHosts(knownHosts: string): void;
  static setTrustedHostKeys(entries: Array<{
    host: string;
    port: number;
    keyType: string;
    publicKey: string;
  }>): void;
  static getKeyDetails(key: string, passphrase?: string): ReturnType<typeof BaseSSHClient.getKeyDetails>;
  static generateKeyPair(type: string, passphrase?: string, keySize?: number, comment?: string): ReturnType<typeof BaseSSHClient.generateKeyPair>;
  static createHostRuntime(config: {
    runtimeId: string;
    ssh: { host: string; port: number; username: string; authMode: 'password' | 'key'; secret: string; passphrase?: string; forwardAgent?: boolean };
    jumpHosts: Array<{ host: string; port: number; username: string; authMode: 'password' | 'key'; secret: string; passphrase?: string; forwardAgent?: boolean }>;
    sessionName: string;
    herdrCommand: string;
    socketPath?: string;
    cachedSocketPath?: string;
  }, lifecycleHandler?: (event: HostRuntimeLifecycleEvent) => void): HostRuntimeConnection;
  static pairHost(code: string, publicKey: string, deviceName: string): Promise<PairHostResult>;
  static connectWithKey(host: string, port: number, username: string, privateKey: string, passphrase?: string, callback?: CallbackFunction<SSHClient>): Promise<SSHClient>;
  static connectWithKeyViaJump(host: string, port: number, username: string, privateKey: string, passphrase: string | undefined, jumpClient: BaseSSHClient, callback?: CallbackFunction<SSHClient>): Promise<SSHClient>;
  static connectWithPassword(host: string, port: number, username: string, password: string, callback?: CallbackFunction<SSHClient>): Promise<SSHClient>;
  static connectWithPasswordViaJump(host: string, port: number, username: string, password: string, jumpClient: BaseSSHClient, callback?: CallbackFunction<SSHClient>): Promise<SSHClient>;
}

export default SSHClient;
