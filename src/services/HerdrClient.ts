import SSHClient, { type HerdrBridgeEvent, type HostRuntimeConnection, type HostRuntimeLifecycleEvent, type HostRuntimeState, type NativeAgentTranscriptState, type NativeAgentTranscriptUpdate, type RuntimeGitDiff, type RuntimeGitRepository, type RuntimeGitStatusEntry, type RuntimeRemoteDirectoryListing, type RuntimeTransfer } from 'react-native-whip-ssh';
import type { HostLatencyMeasurement } from './latencyDiagnostics';
import type { ResponseResult } from '../generated/herdrApi';

import { normalizePrivateKey } from '../lib/privateKey';
import { assertHerdrProtocolCompatible } from '../lib/herdrProtocol';
import { DEFAULT_HERDR_COMMAND } from '../lib/hostProfiles';
import { errorCode } from '../lib/connectionErrors';
import { type HerdrApiRequest, type SessionSnapshotResult } from '../lib/herdrApiBridge';
import { shellQuote } from '../lib/shell';
import { parseCodexIntegrationStatus, type CodexIntegrationStatus } from '../lib/codexSession';
import { type TerminalControlEvent, type TerminalFrame, type TerminalProtocolState } from '../lib/terminalBridge';
import { isSshShellTerminalId } from '../terminalSessions';
import { terminalWebLinkTarget } from '../lib/terminalLinks';
import type { ConnectionProfile, HerdrSnapshot, ServerInfo } from '../types';
import {
  cachedHerdrSocketPath,
  forgetHerdrSocketPath,
  rememberHerdrSocketPath,
} from './herdrSocketPathCache';
import {
  abandonTerminalResizeTrace,
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  withAppPerformanceTrace,
  terminalNativeResponseDelivered,
  terminalNativeResponseReceived,
  terminalNativePreflightStarted,
  terminalNativeWriteQueued,
  terminalNativeWriteStarted,
  terminalResizeDeduplicated,
  terminalResizeNativeDispatchEnded,
  terminalResizeNativeDispatchStarted,
  terminalResizeSuperseded,
  terminalResizeWaitStarted,
  type TerminalInputTrace,
  type TerminalResizeTrace,
} from './performanceTrace';

type TerminalFrameHandler = (frame: TerminalFrame) => void;
type TerminalClosedHandler = (reason?: string) => void;
type TerminalControlHandler = (event: TerminalControlEvent) => void;
type HerdrApiMethod = HerdrApiRequest['method'];
type HerdrApiParams<Method extends HerdrApiMethod> = Extract<
  HerdrApiRequest,
  { method: Method }
>['params'];

export type WorkspaceCreationResult = Extract<ResponseResult, { type: 'workspace_created' }>;
export type TabCreationResult = Extract<ResponseResult, { type: 'tab_created' }>;
export type IntegrationInstall = Extract<ResponseResult, { type: 'integration_install' }>;

export type ClassifiedAgentCommand =
  | { type: 'agent'; kind: 'claude' | 'codex' | 'opencode'; args: string[] }
  | { type: 'shell'; command: string };

const DIRECT_AGENT_KINDS = new Set(['claude', 'codex', 'opencode']);

/**
 * Parse only direct, shell-independent agent invocations. Anything whose shell
 * interpretation could change is intentionally left on pane.send_input.
 */
export function classifyAgentCommand(command: string): ClassifiedAgentCommand {
  const trimmed = command.trim();
  const shell = (): ClassifiedAgentCommand => ({ type: 'shell', command: trimmed });
  if (!trimmed || /[\\\n\r$`]/.test(trimmed)) return shell();

  const argv: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;
  for (const character of trimmed) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        argv.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    if (/[|&;<>()[\]{}*?!#~]/.test(character)) return shell();
    token += character;
    tokenStarted = true;
  }
  if (quote) return shell();
  if (tokenStarted) argv.push(token);
  const kind = argv[0];
  if (!DIRECT_AGENT_KINDS.has(kind)) return shell();
  return {
    type: 'agent',
    kind: kind as Extract<ClassifiedAgentCommand, { type: 'agent' }>['kind'],
    args: argv.slice(1),
  };
}

function managedAgentName(label: string, kind: string, tabNumber: number): string {
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/g, '');
  return (normalized || `${kind}-${tabNumber}`).slice(0, 32);
}

export class CommandLaunchPartialFailure extends Error {
  constructor(
    readonly created: TabCreationResult,
    readonly launchType: 'agent' | 'shell',
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const action = launchType === 'agent' ? 'agent launch' : 'command input';
    super(`Tab ${created.tab.label || created.tab.tab_id} was created, but ${action} failed: ${detail}`);
    this.name = 'CommandLaunchPartialFailure';
  }
}

export { clearHerdrSocketPathCache } from './herdrSocketPathCache';

export function isUnavailableSshChannel(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'CHANNEL_UNAVAILABLE' || code === 'SESSION_CLOSED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /channel (?:is )?not open(?:ed)?|failed to open channel \(connectfailed\)|session is down|socket is not established/i.test(message);
}

interface TerminalConnection {
  onFrame: TerminalFrameHandler;
  onClosed?: TerminalClosedHandler;
  onControl?: TerminalControlHandler;
}

interface SshShellConnection extends TerminalConnection {
  sequence: number;
}

interface TerminalSize {
  columns: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}

const DEFAULT_TERMINAL_SIZE: TerminalSize = {
  columns: 80,
  rows: 24,
  cellWidthPx: 0,
  cellHeightPx: 0,
};

function terminalSizesEqual(left: TerminalSize | undefined, right: TerminalSize): boolean {
  return Boolean(
    left
    && left.columns === right.columns
    && left.rows === right.rows
    && left.cellWidthPx === right.cellWidthPx
    && left.cellHeightPx === right.cellHeightPx,
  );
}

export interface RemoteHtmlPreviewHandle {
  id: string;
  url: string;
  displayUrl: string;
}

export interface RemoteFilePreviewHandle {
  id: string;
  url: string;
}

export function isTerminalAttachmentUploadCancelled(error: unknown): boolean {
  const value = error as { tag?: string; message?: string };
  return value.tag === 'TransferCancelled' || /transfer cancelled/i.test(value.message || String(error));
}

export class HerdrClient {
  static addNetworkChangeListener(listener: () => void): {
    remove: () => void;
  } {
    return SSHClient.addNetworkChangeListener(listener);
  }

  private runtime: HostRuntimeConnection | null = null;
  private runtimeEventHandler: ((event: HostRuntimeLifecycleEvent) => void) | null = null;
  private profile: ConnectionProfile | null = null;
  private terminalConnections = new Map<string, TerminalConnection>();
  private sshShellConnections = new Map<string, SshShellConnection>();
  private terminalOpenings = new Map<string, Promise<void>>();
  private terminalSizes = new Map<string, TerminalSize>();
  private terminalDispatchedSizes = new Map<string, TerminalSize>();
  private terminalProtocolStates = new Map<string, TerminalProtocolState>();
  private terminalInputTraces = new Map<string, TerminalInputTrace[]>();
  private pendingTerminalResizeTraces = new Map<string, TerminalResizeTrace>();
  private apiServer: ServerInfo | null = null;
  private resolvedApiSocketPath: string | null = null;
  private resolvedApiSocketPathFromCache = false;

  async connect(profile: ConnectionProfile, jumpProfiles: ConnectionProfile[] = []): Promise<void> {
    const port = Number(profile.port);
    this.validateSshPort(port);
    jumpProfiles.forEach(jumpProfile => this.validateSshPort(Number(jumpProfile.port)));

    const sshConfig = (value: ConnectionProfile) => ({
      host: value.host.trim(),
      port: Number(value.port),
      username: value.username.trim(),
      authMode: value.authMode,
      secret: value.authMode === 'password' ? value.secret : normalizePrivateKey(value.secret),
      passphrase: value.passphrase || undefined,
      forwardAgent: value.forwardAgent,
    } as const);
    const cachedSocketPath = profile.herdrSocketPath?.trim() ? undefined : cachedHerdrSocketPath(profile) || undefined;
    const runtime = SSHClient.createHostRuntime({
      runtimeId: profile.id,
      ssh: sshConfig(profile),
      jumpHosts: jumpProfiles.map(sshConfig),
      sessionName: profile.sessionName.trim(),
      socketPath: profile.herdrSocketPath?.trim() || undefined,
      cachedSocketPath,
    }, event => this.runtimeEventHandler?.(event));
    this.runtime = runtime;
    this.profile = profile;
    this.apiServer = null;
    this.resolvedApiSocketPath = profile.herdrSocketPath?.trim() ? null : cachedSocketPath || null;
    this.resolvedApiSocketPathFromCache = Boolean(this.resolvedApiSocketPath);
    try {
      await runtime.connect();
    } catch (error) {
      if (this.runtime === runtime) {
        this.runtime = null;
      }
      throw error;
    }
  }

  setRuntimeEventHandler(handler: ((event: HostRuntimeLifecycleEvent) => void) | null): void {
    this.runtimeEventHandler = handler;
  }

  hostState(): HostRuntimeState {
    return this.requireRuntime().hostState();
  }

  refreshHostState(): Promise<HostRuntimeState> {
    return this.requireRuntime().refreshState();
  }

  /** Ask the Rust-owned runtime to recover its transport and native resources. */
  async reconnectControl(profile: ConnectionProfile = this.requireProfile()): Promise<void> {
    this.profile = profile;
    await this.requireRuntime().recover(true, 'control connection unavailable');
  }

  disconnect(): void {
    for (const terminalId of this.sshShellConnections.keys()) {
      this.closeSshShell(terminalId);
    }
    this.runtime?.disconnect().catch(() => undefined);
    this.runtime = null;
    this.profile = null;
    this.apiServer = null;
    this.resolvedApiSocketPath = null;
    this.resolvedApiSocketPathFromCache = false;
    this.terminalOpenings.clear();
    this.terminalConnections.clear();
    this.terminalSizes.clear();
    this.clearAllTerminalBridgeState();
  }

  async openWebTunnel(value: string): Promise<{ url: string; previewId: string } | null> {
    const target = terminalWebLinkTarget(value);
    if (!target.requiresSshTunnel) return null;
    const preview = await this.requireRuntime().startWebPreview(target.url);
    return { url: preview.url, previewId: preview.id };
  }

  closeWebTunnel(previewId: string): Promise<void> {
    return this.requireRuntime().stopPreview(previewId);
  }

  async openRemoteHtmlPreview(remotePath: string): Promise<RemoteHtmlPreviewHandle> {
    const preview = await this.requireRuntime().startHtmlPreview(remotePath);
    return { id: preview.id, url: preview.url, displayUrl: preview.displayUrl || remotePath };
  }

  closeRemoteHtmlPreview(preview: RemoteHtmlPreviewHandle): Promise<void> {
    return this.requireRuntime().stopPreview(preview.id);
  }

  async openRemoteFilePreview(remotePath: string): Promise<RemoteFilePreviewHandle> {
    const preview = await this.requireRuntime().startRemoteFilePreview(remotePath);
    return { id: preview.id, url: preview.url };
  }

  async closeRemoteFilePreview(preview: RemoteFilePreviewHandle): Promise<void> {
    await this.requireRuntime().stopPreview(preview.id);
  }

  listRemoteDirectory(path?: string): Promise<RuntimeRemoteDirectoryListing> {
    return this.requireRuntime().listDirectory(path);
  }

  discoverRemoteGitRepository(path: string): Promise<RuntimeGitRepository | null> {
    return this.requireRuntime().discoverGitRepository(path);
  }

  listRemoteGitChanges(root: string): Promise<RuntimeGitStatusEntry[]> {
    return this.requireRuntime().gitStatus(root);
  }

  loadRemoteGitDiff(repository: RuntimeGitRepository, status: RuntimeGitStatusEntry): Promise<RuntimeGitDiff> {
    return this.requireRuntime().gitDiff(repository, status);
  }

  async downloadRemoteFile(path: string, localDirectoryPath: string): Promise<string> {
    const result = await this.requireRuntime().startDownload(path, localDirectoryPath).result;
    if (!result.localPath) throw new Error('Native download returned no local path');
    return result.localPath;
  }

  async uploadRemoteFile(localFilePath: string, remoteDirectoryPath: string): Promise<void> {
    await this.requireRuntime().startUpload(localFilePath, remoteDirectoryPath).result;
  }

  deleteRemoteEntry(path: string, isDirectory: boolean): Promise<void> {
    return this.requireRuntime().removeRemotePath(path, isDirectory);
  }

  startTerminalAttachmentUpload(localFilePath: string): RuntimeTransfer {
    return this.requireRuntime().startAttachmentUpload(localFilePath);
  }

  cancelTransfer(transferId: string): boolean {
    return this.requireRuntime().cancelTransfer(transferId);
  }

  openCodexAgentTranscript(
    terminalId: string,
    sessionId: string,
    cacheBlob: ArrayBuffer | undefined,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState } {
    return this.requireRuntime().openAgentSession('codex', terminalId, sessionId, cacheBlob, handler);
  }

  openOpenCodeAgentTranscript(
    terminalId: string,
    sessionId: string,
    cacheBlob: ArrayBuffer | undefined,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState } {
    return this.requireRuntime().openAgentSession('opencode', terminalId, sessionId, cacheBlob, handler);
  }

  agentTranscript(key: string): NativeAgentTranscriptState {
    return this.requireRuntime().agentTranscript(key);
  }

  closeAgentTranscript(key: string): void {
    this.runtime?.closeAgentSession(key);
  }

  closeAgentTranscriptTerminal(terminalId: string): void {
    this.runtime?.closeAgentTerminal(terminalId);
  }

  confirmAgentTranscriptCache(confirmationToken: string): boolean {
    return this.requireRuntime().confirmAgentTranscriptCache(confirmationToken);
  }

  /** Explicit user-approved host integration setup; never called during connect. */
  installCodexIntegration(): Promise<IntegrationInstall> {
    return this.apiRequest<IntegrationInstall>('integration.install', { target: 'codex' });
  }

  /** Lazily check setup only after the user requests Chat. */
  async codexIntegrationStatus(): Promise<CodexIntegrationStatus> {
    const command = `${shellQuote(this.requireProfile().herdrCommand.trim() || DEFAULT_HERDR_COMMAND)} integration status`;
    const output = await this.requireRuntime().execute(this.loginShellCommand(command));
    return parseCodexIntegrationStatus(output);
  }

  async openTerminal(
    terminalId: string,
    onFrame: TerminalFrameHandler,
    onClosed?: TerminalClosedHandler,
    onControl?: TerminalControlHandler,
  ): Promise<void> {
    if (isSshShellTerminalId(terminalId)) {
      const connection = this.sshShellConnections.get(terminalId);
      if (connection) {
        connection.onFrame = onFrame;
        connection.onClosed = onClosed;
        connection.onControl = onControl;
        return;
      }
      const opening = this.terminalOpenings.get(terminalId);
      if (opening) {
        await opening;
        const opened = this.sshShellConnections.get(terminalId);
        if (opened) {
          opened.onFrame = onFrame;
          opened.onClosed = onClosed;
          opened.onControl = onControl;
        }
        return;
      }
      const task = this.createSshShell(terminalId, onFrame, onClosed);
      this.terminalOpenings.set(terminalId, task);
      try {
        await task;
      } finally {
        this.terminalOpenings.delete(terminalId);
      }
      return;
    }

    this.terminalConnections.set(terminalId, { onFrame, onClosed, onControl });
    const protocolState = this.terminalProtocolStates.get(terminalId);
    if (protocolState) onControl?.({ type: 'protocol-state', state: protocolState });

    const coldAttach = !this.requireRuntime().hasHerdrBridge(terminalId);
    const bridgeAttachTrace = coldAttach
      ? beginAppPerformanceTrace('Whip terminal bridge attach')
      : null;
    try {
      await this.attachTerminal(terminalId, coldAttach);
    } finally {
      endAppPerformanceTrace(bridgeAttachTrace);
    }
  }

  async writeToTerminal(
    terminalId: string,
    data: string,
    inputTrace: TerminalInputTrace | null = null,
  ): Promise<string> {
    terminalNativePreflightStarted(inputTrace);
    if (isSshShellTerminalId(terminalId)) {
      const opening = this.terminalOpenings.get(terminalId);
      if (opening) await opening;
      this.queueTerminalInputTrace(terminalId, inputTrace);
      terminalNativeWriteStarted(inputTrace);
      try {
        this.requireSshShell(terminalId);
        const bytes = new TextEncoder().encode(data);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        this.requireRuntime().sshShellInput(terminalId, buffer);
        terminalNativeWriteQueued(inputTrace, true);
        return '';
      } catch (error) {
        terminalNativeWriteQueued(inputTrace, false);
        this.removeTerminalInputTrace(terminalId, inputTrace);
        throw error;
      }
    }
    if (!this.requireRuntime().hasHerdrBridge(terminalId)) {
      await this.ensureTerminalBridge(terminalId);
    }
    this.queueTerminalInputTrace(terminalId, inputTrace);
    terminalNativeWriteStarted(inputTrace);
    try {
      await this.requireRuntime().herdrBridgeInput(terminalId, data);
      terminalNativeWriteQueued(inputTrace, true);
    } catch (error) {
      terminalNativeWriteQueued(inputTrace, false);
      this.removeTerminalInputTrace(terminalId, inputTrace);
      throw error;
    }
    return '';
  }

  async clickTerminal(terminalId: string, column: number, row: number): Promise<void> {
    if (isSshShellTerminalId(terminalId)) return;
    await this.ensureTerminalBridge(terminalId);
    const sgrColumn = Math.max(0, Math.min(0xffff, Math.round(column))) + 1;
    const sgrRow = Math.max(0, Math.min(0xffff, Math.round(row))) + 1;
    await this.requireRuntime().herdrBridgeInput(
      terminalId,
      `\u001b[<0;${sgrColumn};${sgrRow}M\u001b[<0;${sgrColumn};${sgrRow}m`,
    );
  }

  async resizeTerminal(
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx = 0,
    cellHeightPx = 0,
    performanceTrace: TerminalResizeTrace | null = null,
    forceDispatch = false,
  ): Promise<void> {
    const size = {
      columns: Math.max(20, columns),
      rows: Math.max(8, rows),
      cellWidthPx: Math.max(0, Math.round(cellWidthPx)),
      cellHeightPx: Math.max(0, Math.round(cellHeightPx)),
    };
    this.terminalSizes.set(terminalId, size);
    terminalResizeWaitStarted(performanceTrace);
    const sshShell = this.sshShellConnections.get(terminalId);
    if (sshShell) {
      const previousSize = this.terminalDispatchedSizes.get(terminalId);
      if (!forceDispatch && terminalSizesEqual(previousSize, size)) {
        terminalResizeDeduplicated(performanceTrace);
        return;
      }
      this.terminalDispatchedSizes.set(terminalId, size);
      terminalResizeNativeDispatchStarted(performanceTrace);
      try {
        this.requireRuntime().resizeSshShell(terminalId, size.columns, size.rows);
        terminalResizeNativeDispatchEnded(performanceTrace, true);
      } catch (error) {
        if (this.terminalDispatchedSizes.get(terminalId) === size) {
          if (previousSize) this.terminalDispatchedSizes.set(terminalId, previousSize);
          else this.terminalDispatchedSizes.delete(terminalId);
        }
        terminalResizeNativeDispatchEnded(performanceTrace, false);
        throw error;
      }
      return;
    }
    if (this.requireRuntime().hasHerdrBridge(terminalId)) {
      const previousSize = this.terminalDispatchedSizes.get(terminalId);
      if (!forceDispatch && terminalSizesEqual(previousSize, size)) {
        terminalResizeDeduplicated(performanceTrace);
        return;
      }
      this.terminalDispatchedSizes.set(terminalId, size);
      terminalResizeNativeDispatchStarted(performanceTrace);
      try {
        await this.requireRuntime().herdrBridgeResize(
          terminalId,
          size.columns,
          size.rows,
          size.cellWidthPx,
          size.cellHeightPx,
        );
        terminalResizeNativeDispatchEnded(performanceTrace, true);
      } catch (error) {
        if (this.terminalDispatchedSizes.get(terminalId) === size) {
          if (previousSize) this.terminalDispatchedSizes.set(terminalId, previousSize);
          else this.terminalDispatchedSizes.delete(terminalId);
        }
        terminalResizeNativeDispatchEnded(performanceTrace, false);
        throw error;
      }
      return;
    }
    if (performanceTrace) {
      if (this.requireRuntime().isHerdrBridgeOpening(terminalId)) {
        terminalResizeSuperseded(performanceTrace);
        return;
      }
      terminalResizeSuperseded(this.pendingTerminalResizeTraces.get(terminalId) || null);
      this.pendingTerminalResizeTraces.set(terminalId, performanceTrace);
    }
  }

  async scrollTerminal(
    terminalId: string,
    direction: 'up' | 'down',
    lines: number,
    column?: number,
    row?: number,
  ): Promise<string> {
    if (isSshShellTerminalId(terminalId)) return '';
    await this.ensureTerminalBridge(terminalId);
    await this.requireRuntime().herdrBridgeScroll(
      terminalId,
      direction === 'up',
      Math.max(1, Math.round(lines)),
      column,
      row,
    );
    return '';
  }

  closeTerminal(terminalId: string): void {
    if (isSshShellTerminalId(terminalId)) {
      this.closeSshShell(terminalId);
      return;
    }
    this.terminalConnections.delete(terminalId);
    this.clearTerminalBridgeState(terminalId);
    this.runtime?.closeHerdrBridge(terminalId);
  }

  isTerminalBridgeRetained(terminalId: string): boolean {
    return Boolean(this.runtime?.hasHerdrBridge(terminalId)) || this.sshShellConnections.has(terminalId) || this.terminalOpenings.has(terminalId);
  }

  async releaseTerminal(terminalId: string): Promise<void> {
    if (isSshShellTerminalId(terminalId)) {
      const opening = this.terminalOpenings.get(terminalId);
      if (opening) await opening.catch(() => undefined);
      this.closeSshShell(terminalId);
      return;
    }
    const connection = this.terminalConnections.get(terminalId);
    if (this.terminalConnections.get(terminalId) !== connection) return;

    this.terminalConnections.delete(terminalId);
    this.clearTerminalBridgeState(terminalId);
    this.runtime?.closeHerdrBridge(terminalId);
  }

  async detachTerminal(terminalId: string): Promise<void> {
    if (isSshShellTerminalId(terminalId)) {
      this.closeSshShell(terminalId);
      return;
    }
    const connection = this.terminalConnections.get(terminalId);
    // Do not detach a replacement controller installed while this renderer was
    // unmounting. The SSH bridge remains open until the terminal or host closes.
    if (this.terminalConnections.get(terminalId) !== connection) return;
    this.terminalConnections.delete(terminalId);
  }

  async closeTerminalBridge(terminalId: string): Promise<void> {
    if (isSshShellTerminalId(terminalId)) {
      this.closeSshShell(terminalId);
      this.terminalOpenings.delete(terminalId);
      this.terminalSizes.delete(terminalId);
      return;
    }
    this.terminalConnections.delete(terminalId);
    this.terminalSizes.delete(terminalId);
    this.clearTerminalBridgeState(terminalId);
    this.runtime?.closeHerdrBridge(terminalId);
  }

  async releaseAllTerminals(): Promise<void> {
    for (const terminalId of this.sshShellConnections.keys()) {
      this.closeSshShell(terminalId);
    }
    this.runtime?.closeAllHerdrBridges();
    this.terminalConnections.clear();
    this.terminalOpenings.clear();
    this.clearAllTerminalBridgeState();
  }

  async snapshot(): Promise<HerdrSnapshot> {
    const state = await this.requireRuntime().refreshState();
    const result = this.snapshotFromHostState(state);
    if (state.syncStatus === 'error') {
      throw new Error(state.error || 'Herdr host state refresh failed');
    }
    return result;
  }

  /**
   * Load the first snapshot on a newly authenticated transport.
   *
   * The snapshot already carries the Herdr version and protocol, so it is also
   * the initial availability probe. Retry only the direct-streamlocal channel;
   * replacing a freshly authenticated SSH session doubles cold-connect latency
   * and delays the offline Herd recovery screen.
   */
  async initialSnapshot(): Promise<HerdrSnapshot> {
    // HostRuntime performs the initial authoritative sync as part of connect.
    // A missing snapshot represents an unavailable Herdr server, not a
    // successful empty host.
    let state = this.requireRuntime().hostState();
    // Defensive for test doubles and runtimes created before their first sync;
    // production HostRuntime normally completes this during connect.
    if (state.revision === 0) state = await this.requireRuntime().refreshState();
    return this.snapshotFromHostState(state);
  }

  /** Mechanical typed-FFI projection; Rust remains authoritative. */
  snapshotFromHostState(state: HostRuntimeState): HerdrSnapshot {
    const raw = state.snapshot as SessionSnapshotResult['snapshot'] | undefined;
    const socket = this.runtime?.resolvedSocketPath();
    if (!raw) {
      this.apiServer = null;
      return this.offlineSnapshot({ running: false, socket });
    }
    assertHerdrProtocolCompatible(raw.protocol);
    if (socket) {
      this.resolvedApiSocketPath = socket;
      this.resolvedApiSocketPathFromCache = false;
      if (!this.requireProfile().herdrSocketPath?.trim()) {
        rememberHerdrSocketPath(this.requireProfile(), socket);
      }
    }
    const server: ServerInfo = {
      running: true,
      version: raw.version,
      protocol: raw.protocol,
      compatible: true,
      socket,
    };
    this.apiServer = server;
    return {
      server,
      focused_workspace_id: raw.focused_workspace_id ?? null,
      focused_tab_id: raw.focused_tab_id ?? null,
      focused_pane_id: raw.focused_pane_id ?? null,
      agents: raw.agents,
      workspaces: raw.workspaces,
      tabs: raw.tabs,
      panes: raw.panes,
      layouts: raw.layouts ?? [],
    };
  }

  private offlineSnapshot(server: ServerInfo): HerdrSnapshot {
    return {
      server,
      focused_workspace_id: null,
      focused_tab_id: null,
      focused_pane_id: null,
      agents: [],
      workspaces: [],
      tabs: [],
      panes: [],
      layouts: [],
    };
  }

  /** Measure an SSH protocol ping/pong RTT without remote process startup. */
  async measureLatency(): Promise<HostLatencyMeasurement> {
    const startedAt = performance.now();
    const sshRttMs = await this.requireRuntime().measureHostLatency();
    const elapsedMs = performance.now() - startedAt;
    if (!Number.isFinite(sshRttMs) || sshRttMs <= 0) {
      throw new Error('Android returned an invalid host latency');
    }
    const roundMilliseconds = (value: number) => Math.round(value * 10) / 10;
    return {
      latencyMs: Math.round(sshRttMs),
      sshRttMs: roundMilliseconds(sshRttMs),
      totalMs: roundMilliseconds(Math.max(sshRttMs, elapsedMs)),
      dispatchMs: roundMilliseconds(Math.max(0, elapsedMs - sshRttMs)),
    };
  }

  async startServer(): Promise<void> {
    const command = `nohup ${this.baseCommand()} server >/tmp/whip-herdr-server.log 2>&1 </dev/null &`;
    await this.requireRuntime().execute(this.loginShellCommand(command));
    this.apiServer = null;
  }

  readPane(paneId: string, lines = 160): Promise<string> {
    return this.apiRequest<{ type: 'pane_read'; read: { text: string } }>('pane.read', {
      pane_id: paneId,
      source: 'recent',
      lines: Math.max(1, Math.min(5000, Math.round(lines))),
      format: 'ansi',
      strip_ansi: false,
    }).then(result => result.read.text);
  }

  async sendAgent(target: string, text: string): Promise<void> {
    await this.apiRequest('agent.prompt', { target, text });
  }

  async focusAgent(target: string): Promise<void> {
    await this.apiFocus('agent.focus', { target });
  }

  async createTabAndLaunchCommand(
    workspaceId: string,
    name: string,
    command: string,
  ): Promise<TabCreationResult> {
    const created = await this.createTab(workspaceId, name);
    const launch = classifyAgentCommand(command);
    try {
      if (launch.type === 'agent') {
        await this.apiRequest('agent.start', {
          name: managedAgentName(created.tab.label, launch.kind, created.tab.number),
          kind: launch.kind,
          pane_id: created.root_pane.pane_id,
          ...(launch.args.length ? { args: launch.args } : {}),
        });
      } else {
        await this.apiRequest('pane.send_input', {
          pane_id: created.root_pane.pane_id,
          text: launch.command,
          keys: ['enter'],
        });
      }
      return created;
    } catch (error) {
      throw new CommandLaunchPartialFailure(created, launch.type, error);
    }
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.apiFocus('workspace.focus', { workspace_id: workspaceId });
  }

  async createWorkspace(label: string, cwd: string): Promise<WorkspaceCreationResult> {
    return this.apiRequest<WorkspaceCreationResult>('workspace.create', {
      label: label.trim() || null,
      cwd: cwd.trim() || null,
      focus: true,
    });
  }

  async renameWorkspace(workspaceId: string, label: string): Promise<void> {
    await this.apiRequest('workspace.rename', {
      workspace_id: workspaceId,
      label,
    });
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.apiRequest('workspace.close', { workspace_id: workspaceId });
  }

  async createTab(workspaceId: string, label: string): Promise<TabCreationResult> {
    return this.apiRequest<TabCreationResult>('tab.create', {
      workspace_id: workspaceId,
      label: label.trim() || null,
      focus: true,
    });
  }

  async focusTab(tabId: string): Promise<void> {
    await this.apiFocus('tab.focus', { tab_id: tabId });
  }

  async focusPane(paneId: string): Promise<void> {
    await this.apiFocus('pane.focus', { pane_id: paneId });
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.apiRequest('tab.rename', { tab_id: tabId, label });
  }

  async closeTab(tabId: string): Promise<void> {
    await this.apiRequest('tab.close', { tab_id: tabId });
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    await this.apiRequest('pane.rename', {
      pane_id: paneId,
      label: label.trim() || null,
    });
  }

  async splitPane(paneId: string, direction: 'right' | 'down'): Promise<void> {
    await this.apiRequest('pane.split', {
      target_pane_id: paneId,
      direction,
      focus: true,
    });
  }

  async zoomPane(paneId: string): Promise<void> {
    await this.apiRequest('pane.zoom', { pane_id: paneId, mode: 'toggle' });
  }

  async closePane(paneId: string): Promise<void> {
    await this.apiRequest('pane.close', { pane_id: paneId });
  }

  async runInPane(paneId: string, text: string): Promise<void> {
    await this.apiRequest('pane.send_input', {
      pane_id: paneId,
      text,
      keys: ['enter'],
    });
  }

  async pasteIntoPane(paneId: string, text: string, keys: readonly string[] = []): Promise<void> {
    await this.apiRequest('pane.send_input', {
      pane_id: paneId,
      text,
      keys: [...keys],
    });
  }

  async submitPastesToPane(paneId: string, parts: readonly string[]): Promise<void> {
    const pasteEvents = parts.filter(Boolean);
    for (const [index, text] of pasteEvents.entries()) {
      if (index > 0) {
        await this.apiRequest('pane.send_text', { pane_id: paneId, text: ' ' });
      }
      // Keep the final paste and Enter in one Herdr request so a successful
      // outbox delivery means the message was submitted, not merely pasted.
      await this.pasteIntoPane(
        paneId,
        text,
        index === pasteEvents.length - 1 ? ['enter'] : [],
      );
    }
    if (!pasteEvents.length) await this.sendPaneKeys(paneId, ['enter']);
  }

  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    await this.apiRequest('pane.send_keys', { pane_id: paneId, keys });
  }

  private async apiFocus<
    T,
    Method extends HerdrApiMethod = HerdrApiMethod,
  >(
    method: Method,
    params: HerdrApiParams<Method>,
  ): Promise<T> {
    return this.apiRequest<T>(method, params);
  }

  private async apiRequest<
    T = unknown,
    Method extends HerdrApiMethod = HerdrApiMethod,
  >(
    method: Method,
    params: HerdrApiParams<Method>,
    socketPath?: string,
    performanceTracePrefix?: string,
  ): Promise<T> {
    const request = { method, params } as HerdrApiRequest;
    if (socketPath) this.resolvedApiSocketPath = socketPath;
    else await this.apiSocketPath();
    const requestApi = async () => await this.requireRuntime().requestHerdrApi(request) as T;
    return performanceTracePrefix
      ? await withAppPerformanceTrace(`${performanceTracePrefix}: API round trip`, requestApi)
      : await requestApi();
  }

  /** Server startup is the only operation that needs the remote login environment. */
  private loginShellCommand(command: string): string {
    const bootstrap = 'exec "${SHELL:-/bin/sh}" -lc "$1"';
    return `exec /bin/sh -c ${shellQuote(bootstrap)} whip ${shellQuote(command)}`;
  }

  private async apiSocketPath(): Promise<string> {
    const profile = this.requireProfile();
    const override = profile.herdrSocketPath?.trim();
    if (override) {
      if (!override.startsWith('/')) throw new Error('Herdr API socket override must be absolute');
      return override;
    }
    if (this.resolvedApiSocketPath) return this.resolvedApiSocketPath;
    const socketPath = await this.requireRuntime().resolveHerdrSocketPath();
    this.resolvedApiSocketPath = socketPath;
    this.resolvedApiSocketPathFromCache = false;
    rememberHerdrSocketPath(profile, socketPath);
    return socketPath;
  }

  private invalidateCachedApiSocketPath(): void {
    if (!this.resolvedApiSocketPathFromCache) return;
    const profile = this.requireProfile();
    if (this.resolvedApiSocketPath) forgetHerdrSocketPath(profile, this.resolvedApiSocketPath);
    this.resolvedApiSocketPath = null;
    this.resolvedApiSocketPathFromCache = false;
  }

  private async probeServer(): Promise<ServerInfo> {
    let socket = await this.apiSocketPath();
    try {
      return await this.pingServer(socket);
    } catch (error) {
      if (!isUnavailableSshChannel(error)) throw error;
      if (this.resolvedApiSocketPathFromCache) {
        this.invalidateCachedApiSocketPath();
        socket = await this.apiSocketPath();
        try {
          return await this.pingServer(socket);
        } catch (retryError) {
          if (!isUnavailableSshChannel(retryError)) throw retryError;
          return { running: false, socket };
        }
      }
      // A missing Herdr socket and a stale SSH session can both surface as an
      // unavailable direct-streamlocal channel. Verify a second SSH subsystem
      // before publishing an offline server snapshot; if that channel also
      // fails, the caller must reconnect instead of erasing its workspaces.
      await this.requireRuntime().remoteHome();
      return { running: false, socket };
    }
  }

  private async pingServer(socket: string): Promise<ServerInfo> {
    const pong = await this.apiRequest<{
      type: 'pong';
      version: string;
      protocol: number;
    }>('ping', {}, socket);
    return {
      running: true,
      version: pong.version,
      protocol: pong.protocol,
      compatible: true,
      socket,
    };
  }

  private baseCommand(): string {
    const profile = this.profile;
    if (!profile) {
      throw new Error('Not connected');
    }
    const command = shellQuote(profile.herdrCommand.trim() || DEFAULT_HERDR_COMMAND);
    return profile.sessionName.trim() ? `${command} --session ${shellQuote(profile.sessionName.trim())}` : command;
  }

  private requireRuntime(): HostRuntimeConnection {
    if (!this.runtime) throw new Error('Host runtime is not active');
    return this.runtime;
  }

  private requireProfile(): ConnectionProfile {
    if (!this.profile) {
      throw new Error('SSH connection is not active');
    }
    return this.profile;
  }

  private validateSshPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be between 1 and 65535');
    }
  }

  private async createSshShell(terminalId: string, onFrame: TerminalFrameHandler, onClosed?: TerminalClosedHandler): Promise<void> {
    const connection: SshShellConnection = {
      onFrame,
      onClosed,
      sequence: 0,
    };
    const size = this.terminalSizes.get(terminalId) || DEFAULT_TERMINAL_SIZE;
    const onData = (data: ArrayBuffer) => {
      const active = this.sshShellConnections.get(terminalId);
      if (active !== connection) return;
      const activeSize = this.terminalSizes.get(terminalId) || DEFAULT_TERMINAL_SIZE;
      this.deliverTracedTerminalFrame(terminalId, () => {
        active.onFrame({
          type: 'terminal.frame',
          seq: ++active.sequence,
          encoding: 'utf8',
          width: activeSize.columns,
          height: activeSize.rows,
          full: false,
          bytes: data,
        });
      });
    };
    this.sshShellConnections.set(terminalId, connection);
    try {
      await this.requireRuntime().openSshShell(terminalId, size.columns, size.rows, {
        data: onData,
        closed: reason => {
          const active = this.sshShellConnections.get(terminalId);
          if (active !== connection) return;
          this.sshShellConnections.delete(terminalId);
          this.terminalDispatchedSizes.delete(terminalId);
          active.onClosed?.(reason);
        },
      });
      this.terminalDispatchedSizes.set(terminalId, size);
    } catch (error) {
      this.closeSshShell(terminalId);
      throw error;
    }
  }

  private closeSshShell(terminalId: string): void {
    const connection = this.sshShellConnections.get(terminalId);
    if (!connection) return;
    this.sshShellConnections.delete(terminalId);
    this.terminalDispatchedSizes.delete(terminalId);
    this.runtime?.closeSshShell(terminalId);
  }

  private requireSshShell(terminalId: string): SshShellConnection {
    const connection = this.sshShellConnections.get(terminalId);
    if (!connection) throw new Error(`SSH shell ${terminalId} is not connected`);
    return connection;
  }

  private async attachTerminal(terminalId: string, coldAttach: boolean): Promise<void> {
    const size = this.terminalSizes.get(terminalId) || DEFAULT_TERMINAL_SIZE;
    const resizeTrace = this.pendingTerminalResizeTraces.get(terminalId) || null;
    try {
      await this.ensureTerminalBridge(terminalId, size);
    } catch (error) {
      this.pendingTerminalResizeTraces.delete(terminalId);
      abandonTerminalResizeTrace(resizeTrace);
      throw error;
    }
    this.pendingTerminalResizeTraces.delete(terminalId);
    const initialResizeTrace = coldAttach
      ? beginAppPerformanceTrace('Whip Herdr terminal initial resize')
      : null;
    const uncorrelatedNativeDispatchTrace = resizeTrace
      ? null
      : beginAppPerformanceTrace('Whip terminal resize native dispatch');
    const previousSize = this.terminalDispatchedSizes.get(terminalId);
    this.terminalDispatchedSizes.set(terminalId, size);
    terminalResizeNativeDispatchStarted(resizeTrace);
    try {
      await this.requireRuntime().herdrBridgeResize(
        terminalId,
        size.columns,
        size.rows,
        size.cellWidthPx,
        size.cellHeightPx,
      );
      terminalResizeNativeDispatchEnded(resizeTrace, true);
    } catch (error) {
      if (this.terminalDispatchedSizes.get(terminalId) === size) {
        if (previousSize) this.terminalDispatchedSizes.set(terminalId, previousSize);
        else this.terminalDispatchedSizes.delete(terminalId);
      }
      terminalResizeNativeDispatchEnded(resizeTrace, false);
      throw error;
    } finally {
      endAppPerformanceTrace(uncorrelatedNativeDispatchTrace);
      endAppPerformanceTrace(initialResizeTrace);
    }
  }

  private async ensureTerminalBridge(terminalId: string, requestedSize?: TerminalSize): Promise<void> {
    if (this.requireRuntime().hasHerdrBridge(terminalId)) return;
    const size = requestedSize || this.terminalSizes.get(terminalId) || DEFAULT_TERMINAL_SIZE;
    this.updateTerminalProtocolState(terminalId, {
      kittyKeyboardReportAll: false,
    });
    await this.requireRuntime().startHerdrBridge(
      terminalId,
      true,
      size.columns,
      size.rows,
      size.cellWidthPx,
      size.cellHeightPx,
      event => this.handleHerdrBridgeEvent(terminalId, event),
    );
  }

  private handleHerdrBridgeEvent(terminalId: string, event: HerdrBridgeEvent): void {
    if (event.type === 'terminal') {
      if (typeof event.seq === 'number' && typeof event.width === 'number' && typeof event.height === 'number' && (typeof event.bytes === 'string' || event.bytes instanceof ArrayBuffer || ArrayBuffer.isView(event.bytes))) {
        this.deliverTracedTerminalFrame(terminalId, () => {
          this.terminalConnections.get(terminalId)?.onFrame({
            type: 'terminal.frame',
            seq: event.seq as number,
            encoding: 'ansi',
            width: event.width as number,
            height: event.height as number,
            full: Boolean(event.full),
            bytes: event.bytes as string | ArrayBufferView,
            final: event.final !== false,
            inboundTraceCookie: event.inboundTraceCookie ?? null,
          });
        });
      }
      return;
    }
    if (event.type === 'terminal_bell') {
      const count = Math.max(0, Math.min(0xffff, Math.trunc(event.count || 0)));
      if (count > 0) {
        this.terminalConnections.get(terminalId)?.onFrame({
          type: 'terminal.frame',
          seq: 0,
          encoding: 'utf8',
          width: 0,
          height: 0,
          full: false,
          bytes: '\u0007'.repeat(count),
        });
      }
      return;
    }
    if (event.type === 'mouse_capture') {
      // Direct terminal attachments do not render the Herdr TUI. This flag also
      // reflects Herdr's outer UI mouse setting, so it must not control Whip's
      // terminal surface.
      return;
    }
    if (event.type === 'kitty_keyboard_report_all') {
      this.updateTerminalProtocolState(terminalId, { kittyKeyboardReportAll: event.flag === true });
      return;
    }
    if (event.type === 'clipboard') {
      this.terminalConnections.get(terminalId)?.onControl?.({
        type: 'clipboard-write',
        text: event.text || '',
      });
      return;
    }
    if (event.type === 'title') {
      this.terminalConnections.get(terminalId)?.onControl?.({
        type: 'title',
        title: event.text || '',
      });
      return;
    }
    if (event.type === 'closed') {
      this.clearTerminalBridgeState(terminalId);
      this.terminalConnections.get(terminalId)?.onClosed?.(event.text || 'Herdr remote-client-bridge closed');
    }
  }

  private updateTerminalProtocolState(
    terminalId: string,
    update: Partial<TerminalProtocolState>,
  ): void {
    const current = this.terminalProtocolStates.get(terminalId) || {
      kittyKeyboardReportAll: false,
    };
    const state = { ...current, ...update };
    this.terminalProtocolStates.set(terminalId, state);
    this.terminalConnections.get(terminalId)?.onControl?.({ type: 'protocol-state', state });
  }

  private clearTerminalBridgeState(terminalId: string): void {
    abandonTerminalResizeTrace(this.pendingTerminalResizeTraces.get(terminalId) || null);
    this.pendingTerminalResizeTraces.delete(terminalId);
    this.terminalDispatchedSizes.delete(terminalId);
    this.terminalProtocolStates.delete(terminalId);
  }

  private clearAllTerminalBridgeState(): void {
    for (const trace of this.pendingTerminalResizeTraces.values()) {
      abandonTerminalResizeTrace(trace);
    }
    this.pendingTerminalResizeTraces.clear();
    this.terminalDispatchedSizes.clear();
    this.terminalProtocolStates.clear();
  }

  private queueTerminalInputTrace(
    terminalId: string,
    trace: TerminalInputTrace | null,
  ): void {
    if (!trace) return;
    const queue = this.terminalInputTraces.get(terminalId) || [];
    queue.push(trace);
    this.terminalInputTraces.set(terminalId, queue);
  }

  private removeTerminalInputTrace(
    terminalId: string,
    trace: TerminalInputTrace | null,
  ): void {
    if (!trace) return;
    const queue = this.terminalInputTraces.get(terminalId);
    if (!queue) return;
    const next = queue.filter(item => item !== trace);
    if (next.length) this.terminalInputTraces.set(terminalId, next);
    else this.terminalInputTraces.delete(terminalId);
  }

  private takeTerminalInputTrace(terminalId: string): TerminalInputTrace | null {
    const queue = this.terminalInputTraces.get(terminalId);
    if (!queue) return null;
    let trace: TerminalInputTrace | undefined;
    while ((trace = queue.shift())) {
      if (terminalNativeResponseReceived(trace)) break;
      trace = undefined;
    }
    if (!queue.length) this.terminalInputTraces.delete(terminalId);
    return trace || null;
  }

  private deliverTracedTerminalFrame(terminalId: string, deliver: () => void): void {
    const trace = this.takeTerminalInputTrace(terminalId);
    try {
      deliver();
    } finally {
      terminalNativeResponseDelivered(trace);
    }
  }
}
