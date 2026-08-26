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
  | { type: 'data'; data: string }
  | { type: 'closed'; reason?: string };

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
    handler: (event: HerdrEventStreamEvent) => void,
    callback?: CallbackFunction<void>,
  ): Promise<void>;
  writeHerdrEventStream(value: string): Promise<void>;
  closeHerdrEventStream(): void;
  requestHerdrApi(socketPath: string, request: string): Promise<string>;
  startHerdrCommandStream(
    command: string,
    handler: (event: HerdrCommandStreamEvent) => void,
    callback?: CallbackFunction<void>,
  ): Promise<void>;
  writeHerdrCommandStream(value: string): Promise<void>;
  closeHerdrCommandStream(): void;
  disconnect(): void;
}
