import BaseSSHClient, { type CallbackFunction } from 'react-native-russh';

export * from 'react-native-russh';

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
  | { type: 'terminal-state'; terminalId: string; state: string; error?: string }
  | { type: 'host-state'; state: HostRuntimeState; changedAgentPaneIds: string[] }
  | { type: 'event-stream-closed'; reason: string }
  | { type: 'event-stream-restored'; generation: number }
  | { type: 'fatal-error'; message: string };

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

export interface HostRuntimeConnection {
  readonly runtimeId: string;
  readonly transportKey: string;
  transportClient: SSHClient;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  recover(immediate: boolean, reason: string): Promise<void>;
  hostState(): HostRuntimeState;
  refreshState(): Promise<HostRuntimeState>;
  requestHerdrApi(request: { method: string; params: object }): Promise<Record<string, unknown>>;
  startHerdrBridge(terminalId: string, takeover: boolean, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number, launchMode: number, handler: (event: HerdrBridgeEvent) => void): Promise<void>;
  herdrBridgeInput(terminalId: string, text: string): Promise<void>;
  herdrBridgeResize(terminalId: string, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number): Promise<void>;
  herdrBridgeScroll(terminalId: string, up: boolean, lines: number, column?: number, row?: number, modifiers?: number): Promise<void>;
  closeHerdrBridge(terminalId: string): void;
  closeAllHerdrBridges(): void;
  hasHerdrBridge(terminalId: string): boolean;
  isHerdrBridgeOpening(terminalId: string): boolean;
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

/** Whip's private product adapter over the public react-native-russh client. */
export default class SSHClient extends BaseSSHClient {
  static createHostRuntime(config: {
    runtimeId: string;
    ssh: { host: string; port: number; username: string; authMode: 'password' | 'key'; secret: string; passphrase?: string; forwardAgent?: boolean };
    jumpHosts: Array<{ host: string; port: number; username: string; authMode: 'password' | 'key'; secret: string; passphrase?: string; forwardAgent?: boolean }>;
    sessionName: string;
    socketPath?: string;
    cachedSocketPath?: string;
  }, lifecycleHandler?: (event: HostRuntimeLifecycleEvent) => void): HostRuntimeConnection;
  static pairHost(
    code: string,
    publicKey: string,
    deviceName: string,
  ): Promise<PairHostResult>;
  static connectWithKey(
    host: string,
    port: number,
    username: string,
    privateKey: string,
    passphrase?: string,
    callback?: CallbackFunction<SSHClient>,
  ): Promise<SSHClient>;
  static connectWithKeyViaJump(
    host: string,
    port: number,
    username: string,
    privateKey: string,
    passphrase: string | undefined,
    jumpClient: BaseSSHClient,
    callback?: CallbackFunction<SSHClient>,
  ): Promise<SSHClient>;
  static connectWithPassword(
    host: string,
    port: number,
    username: string,
    password: string,
    callback?: CallbackFunction<SSHClient>,
  ): Promise<SSHClient>;
  static connectWithPasswordViaJump(
    host: string,
    port: number,
    username: string,
    password: string,
    jumpClient: BaseSSHClient,
    callback?: CallbackFunction<SSHClient>,
  ): Promise<SSHClient>;
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
