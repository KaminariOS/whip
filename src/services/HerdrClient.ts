import SSHClient, { type HerdrBridgeEvent, type HostRuntimeConnection, type HostRuntimeLifecycleEvent, type HostRuntimeState, type NativeAgentTranscriptState, type NativeAgentTranscriptUpdate, type RuntimeGitDiff, type RuntimeGitRepository, type RuntimeGitStatusEntry, type RuntimeRemoteDirectoryListing, type RuntimeTabLaunch, type RuntimeTransfer } from 'react-native-whip-ssh';
import type { HostLatencyMeasurement } from './latencyDiagnostics';
import type { ResponseResult } from '../generated/herdrApi';

import { normalizePrivateKey } from '../lib/privateKey';
import { settledPromise } from '../lib/promises';
import { assertHerdrProtocolCompatible } from '../lib/herdrProtocol';
import { DEFAULT_HERDR_COMMAND } from '../lib/hostProfiles';
import { errorCode } from '../lib/connectionErrors';
import { type HerdrApiRequest, type SessionSnapshotResult } from '../lib/herdrApiBridge';
import type { CodexIntegrationStatus } from '../lib/codexSession';
import { type TerminalControlEvent, type TerminalFrame, type TerminalProtocolState } from '../lib/terminalBridge';
import { isSshShellTerminalId } from '../terminalSessions';
import { terminalWebLinkTarget } from '../lib/terminalLinks';
import type { ConnectionProfile, HerdrSnapshot, ServerInfo } from '../types';
import {
  persistedHerdrSocketPathHint,
  persistHerdrSocketPathHint,
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
import {
  networkErrorKind,
  networkErrorMessage,
  recordNetworkDiagnostic,
} from './networkDiagnostics';

type TerminalFrameHandler = (frame: TerminalFrame) => void;
type TerminalClosedHandler = (reason?: string) => void;
type TerminalControlHandler = (event: TerminalControlEvent) => void;
type HerdrApiMethod = HerdrApiRequest['method'];
type HerdrApiParams<Method extends HerdrApiMethod> = Extract<
  HerdrApiRequest,
  { method: Method }
>['params'];

const HOST_KEY_CHALLENGE_CODES = new Set([
  'HOST_KEY_UNKNOWN',
  'HOST_KEY_CHANGED',
]);

function isHostKeyChallenge(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && HOST_KEY_CHALLENGE_CODES.has(code);
}

export type WorkspaceCreationResult = Extract<ResponseResult, { type: 'workspace_created' }>;
export type TabCreationResult = Extract<ResponseResult, { type: 'tab_created' }>;
export type IntegrationInstall = Extract<ResponseResult, { type: 'integration_install' }>;

export type TabLaunchIntent = RuntimeTabLaunch;

declare const terminalAttachmentIdBrand: unique symbol;

/** Opaque ownership token for one installed terminal controller. */
export type TerminalAttachmentId = {
  readonly [terminalAttachmentIdBrand]: true;
};

export class CommandLaunchPartialFailure extends Error {
  constructor(
    readonly created: TabCreationResult,
    readonly launchType: 'agent' | 'command',
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const action = launchType === 'agent' ? 'agent launch' : 'command input';
    super(`Tab ${created.tab.label || created.tab.tab_id} was created, but ${action} failed: ${detail}`);
    this.name = 'CommandLaunchPartialFailure';
  }
}

export { clearHerdrSocketPathCache } from './herdrSocketPathCache';

interface TerminalConnection {
  attachmentId: TerminalAttachmentId;
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

const TERMINAL_STATE_REFRESH_DEBOUNCE_MS = 120;

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
  return errorCode(error) === 'TRANSFER_CANCELLED';
}

export class HerdrClient {
  static addNetworkChangeListener(listener: () => void): {
    remove: () => void;
  } {
    return SSHClient.addNetworkChangeListener(listener);
  }

  private runtime: HostRuntimeConnection | null = null;
  private disconnecting: Promise<void> | null = null;
  private runtimeAwaitingHostKeyTrust = false;
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
  private terminalStateRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  private createTerminalAttachmentId(): TerminalAttachmentId {
    return Object.freeze({}) as TerminalAttachmentId;
  }

  async connect(profile: ConnectionProfile, jumpProfiles: ConnectionProfile[] = []): Promise<void> {
    await this.disconnecting;
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
    const cachedSocketPath = profile.herdrSocketPath?.trim()
      ? undefined
      : persistedHerdrSocketPathHint(profile.id) || undefined;
    const endpoint = profile.host.trim();
    recordNetworkDiagnostic('info', 'host-runtime-connect-started', {
      sessionId: profile.id,
      endpoint,
      endpointKind: /^\d{1,3}(?:\.\d{1,3}){3}$/.test(endpoint)
        ? 'ipv4'
        : endpoint.includes(':') ? 'ipv6' : 'hostname',
      port,
      authMode: profile.authMode,
      jumpHostCount: jumpProfiles.length,
      explicitSocketPath: Boolean(profile.herdrSocketPath?.trim()),
      cachedSocketPath: Boolean(cachedSocketPath),
    });
    const retryRuntime = this.runtimeAwaitingHostKeyTrust && this.profile === profile
      ? this.runtime
      : null;
    if (this.runtimeAwaitingHostKeyTrust && !retryRuntime) {
      await this.runtime?.disconnect().catch(error => {
        recordRuntimeCleanupFailure('stale-runtime-disconnect-failed', error);
      });
      this.runtime = null;
      this.runtimeAwaitingHostKeyTrust = false;
    }
    const runtime = retryRuntime ?? SSHClient.createHostRuntime({
      runtimeId: profile.id,
      ssh: sshConfig(profile),
      jumpHosts: jumpProfiles.map(sshConfig),
      sessionName: profile.sessionName.trim(),
      herdrCommand: profile.herdrCommand.trim() || DEFAULT_HERDR_COMMAND,
      socketPath: profile.herdrSocketPath?.trim() || undefined,
      cachedSocketPath,
    }, event => this.runtimeEventHandler?.(event));
    this.runtime = runtime;
    this.profile = profile;
    try {
      await runtime.connect();
      this.runtimeAwaitingHostKeyTrust = false;
    } catch (error) {
      this.runtimeAwaitingHostKeyTrust = isHostKeyChallenge(error);
      if (this.runtime === runtime && !this.runtimeAwaitingHostKeyTrust) {
        await this.disconnect();
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

  async refreshHostState(): Promise<HostRuntimeState> {
    try {
      return await this.requireRuntime().refreshState();
    } catch (error) {
      recordNetworkDiagnostic('warn', 'host-state-refresh-rejected', {
        error: networkErrorMessage(error),
        errorKind: networkErrorKind(error),
      });
      throw error;
    }
  }

  /** Ask the Rust-owned runtime to recover its transport and native resources. */
  async reconnectControl(profile: ConnectionProfile = this.requireProfile()): Promise<void> {
    this.profile = profile;
    await this.requireRuntime().recover(true, 'control connection unavailable');
  }

  disconnect(): Promise<void> {
    if (!this.runtime) return this.disconnecting ?? Promise.resolve();

    if (this.terminalStateRefreshTimer !== null) {
      clearTimeout(this.terminalStateRefreshTimer);
      this.terminalStateRefreshTimer = null;
    }
    for (const terminalId of this.sshShellConnections.keys()) {
      this.closeSshShell(terminalId);
    }
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeAwaitingHostKeyTrust = false;
    this.profile = null;
    this.terminalOpenings.clear();
    this.terminalConnections.clear();
    this.terminalSizes.clear();
    this.clearAllTerminalBridgeState();

    const disconnecting = runtime.disconnect()
      .catch(error => {
        recordRuntimeCleanupFailure('host-runtime-disconnect-failed', error);
      })
      .finally(() => {
        if (this.disconnecting === disconnecting) this.disconnecting = null;
      });
    this.disconnecting = disconnecting;
    return disconnecting;
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

  bindCodexAgentTranscript(
    terminalId: string,
    sessionId: string,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState } {
    return this.requireRuntime().bindAgentSession('codex', terminalId, sessionId, handler);
  }

  openOpenCodeAgentTranscript(
    terminalId: string,
    sessionId: string,
    cacheBlob: ArrayBuffer | undefined,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState } {
    return this.requireRuntime().openAgentSession('opencode', terminalId, sessionId, cacheBlob, handler);
  }

  bindOpenCodeAgentTranscript(
    terminalId: string,
    sessionId: string,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState } {
    return this.requireRuntime().bindAgentSession('opencode', terminalId, sessionId, handler);
  }

  startAgentTranscript(
    terminalId: string,
    key: string,
    cacheBlob: ArrayBuffer | undefined,
  ): NativeAgentTranscriptState {
    return this.requireRuntime().startAgentSession(terminalId, key, cacheBlob);
  }

  agentTranscript(key: string): NativeAgentTranscriptState {
    return this.requireRuntime().agentTranscript(key);
  }

  closeAgentTranscript(key: string): void {
    this.runtime?.closeAgentSession(key);
  }

  closeAgentTranscriptTerminal(terminalId: string): string | undefined {
    return this.runtime?.closeAgentTerminal(terminalId);
  }

  confirmAgentTranscriptCache(confirmationToken: string): boolean {
    return this.requireRuntime().confirmAgentTranscriptCache(confirmationToken);
  }

  /** Explicit user-approved host integration setup; never called during connect. */
  installCodexIntegration(): Promise<IntegrationInstall> {
    return this.requireRuntime().installAgentIntegration('codex').then(result => ({
      type: 'integration_install',
      target: result.kind,
      details: { messages: result.messages },
    } as IntegrationInstall));
  }

  /** Lazily check setup only after the user requests Chat. */
  codexIntegrationStatus(): Promise<CodexIntegrationStatus> {
    return this.requireRuntime().agentIntegrationStatus('codex');
  }

  async openTerminal(
    terminalId: string,
    onFrame: TerminalFrameHandler,
    onClosed?: TerminalClosedHandler,
    onControl?: TerminalControlHandler,
  ): Promise<TerminalAttachmentId> {
    const attachmentId = this.createTerminalAttachmentId();
    if (isSshShellTerminalId(terminalId)) {
      const connection = this.sshShellConnections.get(terminalId);
      if (connection) {
        connection.attachmentId = attachmentId;
        connection.onFrame = onFrame;
        connection.onClosed = onClosed;
        connection.onControl = onControl;
        return attachmentId;
      }
      const opening = this.terminalOpenings.get(terminalId);
      if (opening) {
        await opening;
        const opened = this.sshShellConnections.get(terminalId);
        if (opened) {
          opened.attachmentId = attachmentId;
          opened.onFrame = onFrame;
          opened.onClosed = onClosed;
          opened.onControl = onControl;
        }
        return attachmentId;
      }
      const task = this.createSshShell(terminalId, attachmentId, onFrame, onClosed);
      this.terminalOpenings.set(terminalId, task);
      try {
        await task;
      } finally {
        this.terminalOpenings.delete(terminalId);
      }
      return attachmentId;
    }

    this.terminalConnections.set(terminalId, {
      attachmentId,
      onFrame,
      onClosed,
      onControl,
    });
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
    return attachmentId;
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
        this.scheduleTerminalStateRefresh();
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
    this.scheduleTerminalStateRefresh();
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

  async releaseTerminal(
    terminalId: string,
    attachmentId: TerminalAttachmentId,
  ): Promise<void> {
    if (isSshShellTerminalId(terminalId)) {
      const opening = this.terminalOpenings.get(terminalId);
      if (opening) await settledPromise(opening);
      this.closeSshShell(terminalId, attachmentId);
      return;
    }
    const connection = this.terminalConnections.get(terminalId);
    if (connection?.attachmentId !== attachmentId) return;

    this.terminalConnections.delete(terminalId);
    this.clearTerminalBridgeState(terminalId);
    this.runtime?.closeHerdrBridge(terminalId);
  }

  async detachTerminal(
    terminalId: string,
    attachmentId: TerminalAttachmentId,
  ): Promise<void> {
    if (isSshShellTerminalId(terminalId)) {
      this.closeSshShell(terminalId, attachmentId);
      return;
    }
    const connection = this.terminalConnections.get(terminalId);
    if (connection?.attachmentId !== attachmentId) return;
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
      return this.offlineSnapshot({ running: false, socket });
    }
    assertHerdrProtocolCompatible(raw.protocol);
    if (socket && !this.requireProfile().herdrSocketPath?.trim()) {
      persistHerdrSocketPathHint(this.requireProfile().id, socket);
    }
    const server: ServerInfo = {
      running: true,
      version: raw.version,
      protocol: raw.protocol,
      compatible: true,
      socket,
    };
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
    const measurement = await this.requireRuntime().measureHostLatency();
    const { sshRttMs } = measurement;
    if (!Number.isFinite(sshRttMs) || sshRttMs <= 0) {
      throw new Error('Android returned an invalid host latency');
    }
    const roundMilliseconds = (value: number) => Math.round(value * 10) / 10;
    return {
      latencyMs: Math.round(sshRttMs),
      sshRttMs: roundMilliseconds(sshRttMs),
      totalMs: roundMilliseconds(measurement.totalMs),
      runtimeOverheadMs: roundMilliseconds(measurement.runtimeOverheadMs),
    };
  }

  async startServer(): Promise<void> {
    await this.requireRuntime().startHerdrServer();
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

  async createTabWithLaunch(
    workspaceId: string,
    name: string,
    launch: TabLaunchIntent,
  ): Promise<TabCreationResult> {
    try {
      return await this.requireRuntime().createTabWithLaunch(
        workspaceId,
        name,
        launch,
      ) as TabCreationResult;
    } catch (error) {
      const native = error as {
        code?: string;
        created?: TabCreationResult;
        launchType?: 'agent' | 'command';
      };
      if (native.code === 'TAB_LAUNCH_FAILED' && native.created && native.launchType) {
        throw new CommandLaunchPartialFailure(
          native.created,
          native.launchType,
          error,
        );
      }
      throw error;
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
    await this.requireRuntime().submitPastes(paneId, [...parts]);
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
    performanceTracePrefix?: string,
  ): Promise<T> {
    const request = { method, params } as HerdrApiRequest;
    const requestApi = async () => await this.requireRuntime().requestHerdrApi(request) as T;
    return performanceTracePrefix
      ? await withAppPerformanceTrace(`${performanceTracePrefix}: API round trip`, requestApi)
      : await requestApi();
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

  private async createSshShell(
    terminalId: string,
    attachmentId: TerminalAttachmentId,
    onFrame: TerminalFrameHandler,
    onClosed?: TerminalClosedHandler,
  ): Promise<void> {
    const connection: SshShellConnection = {
      attachmentId,
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

  private closeSshShell(
    terminalId: string,
    attachmentId?: TerminalAttachmentId,
  ): void {
    const connection = this.sshShellConnections.get(terminalId);
    if (!connection) return;
    if (attachmentId && connection.attachmentId !== attachmentId) return;
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
      this.scheduleTerminalStateRefresh();
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

  private scheduleTerminalStateRefresh(): void {
    if (this.terminalStateRefreshTimer !== null) {
      clearTimeout(this.terminalStateRefreshTimer);
    }
    this.terminalStateRefreshTimer = setTimeout(() => {
      this.terminalStateRefreshTimer = null;
      this.runtime?.refreshState().catch(error => {
        recordRuntimeCleanupFailure('terminal-state-refresh-failed', error);
      });
    }, TERMINAL_STATE_REFRESH_DEBOUNCE_MS);
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

function recordRuntimeCleanupFailure(event: string, error: unknown): void {
  recordNetworkDiagnostic('warn', event, {
    error: networkErrorMessage(error),
    errorKind: networkErrorKind(error),
  });
}
