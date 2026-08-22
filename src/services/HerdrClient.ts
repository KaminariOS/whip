import SSHClient, { type HerdrBridgeEvent, type LsResult, PtyType } from 'react-native-whip-ssh';

import { normalizePrivateKey } from '../lib/privateKey';
import { normalizeRemotePath, remoteEntryName, sortRemoteEntries } from '../lib/remoteFiles';
import { uniqueRemoteAttachmentName } from '../lib/attachmentPaste';
import { createSecureId } from '../lib/secureId';
import { assertHerdrProtocolCompatible } from '../lib/herdrProtocol';
import { apiEvent, apiErrorMessage, apiRequestLine, eventsSubscribeRequest, HerdrApiBridgeDecoder, type HerdrApiEvent, type HerdrApiMessage, type HerdrApiRequest, type SessionSnapshotResult } from '../lib/herdrApiBridge';
import { shellQuote } from '../lib/shell';
import { parseRemoteGitDiff, parseRemoteGitRepository, parseRemoteGitStatus, remoteGitDiffCommand, remoteGitRepositoryCommand, remoteGitStatusCommand, type RemoteGitDiff, type RemoteGitRepository, type RemoteGitStatusEntry } from '../lib/remoteGit';
import { parseRemoteHtmlPreviewStart, remoteHtmlPreviewPageUrl, remoteHtmlPreviewStartCommand, remoteHtmlPreviewStopCommand, type RemoteHtmlServerProcess } from '../lib/remoteHtmlPreview';
import { type TerminalControlEvent, type TerminalFrame, type TerminalProtocolState } from '../lib/terminalBridge';
import { isSshShellTerminalId } from '../terminalSessions';
import { localTunnelUrl, terminalWebLinkTarget } from '../lib/terminalLinks';
import type { ConnectionProfile, HerdrSnapshot, ServerInfo } from '../types';

type TerminalFrameHandler = (frame: TerminalFrame) => void;
type TerminalClosedHandler = (reason?: string) => void;
type TerminalControlHandler = (event: TerminalControlEvent) => void;
type ApiEventHandler = (event: HerdrApiEvent) => void;

interface CachedApiSocketPath {
  fingerprint: string;
  socketPath: string;
}

const apiSocketPathCache = new Map<string, CachedApiSocketPath>();

function apiSocketPathFingerprint(profile: ConnectionProfile): string {
  return [profile.host.trim(), profile.port.trim(), profile.username.trim(), profile.sessionName.trim()].join('\n');
}

function cachedApiSocketPath(profile: ConnectionProfile): string | null {
  const cached = apiSocketPathCache.get(profile.id);
  return cached?.fingerprint === apiSocketPathFingerprint(profile) ? cached.socketPath : null;
}

export function clearHerdrSocketPathCache(): void {
  apiSocketPathCache.clear();
}

export function isUnavailableSshChannel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /channel (?:is )?not open(?:ed)?|failed to open channel \(connectfailed\)|session is down|socket is not established/i.test(message);
}

interface TerminalConnection {
  onFrame: TerminalFrameHandler;
  onClosed?: TerminalClosedHandler;
  onControl?: TerminalControlHandler;
}

interface SshShellConnection extends TerminalConnection {
  client: SSHClient;
  sequence: number;
}

interface EventSubscription {
  paneIds: string[];
  onEvent: ApiEventHandler;
  onClosed?: TerminalClosedHandler;
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

export interface RemoteHtmlPreviewHandle {
  url: string;
  displayUrl: string;
  localPort: number;
}

export interface RemoteSftpFileServerHandle {
  url: string;
  localPort: number;
}

interface RemoteHtmlPreviewProcess extends RemoteHtmlServerProcess {
  client: SSHClient;
}

export class HerdrClient {
  static addNetworkChangeListener(listener: () => void): {
    remove: () => void;
  } {
    return SSHClient.addNetworkChangeListener(listener);
  }

  private client: SSHClient | null = null;
  private profile: ConnectionProfile | null = null;
  private jumpProfiles: ConnectionProfile[] = [];
  private proxyClients = new Map<SSHClient, SSHClient[]>();
  private terminalConnections = new Map<string, TerminalConnection>();
  private sshShellConnections = new Map<string, SshShellConnection>();
  private terminalOpenings = new Map<string, Promise<void>>();
  private terminalSizes = new Map<string, TerminalSize>();
  private terminalBridges = new Set<string>();
  private terminalBridgeGenerations = new Map<string, number>();
  private terminalProtocolStates = new Map<string, TerminalProtocolState>();
  private terminalBridgeSequence = 0;
  private eventClient: SSHClient | null = null;
  private eventSubscription: EventSubscription | null = null;
  private eventGeneration = 0;
  private apiServer: ServerInfo | null = null;
  private resolvedApiSocketPath: string | null = null;
  private resolvedApiSocketPathFromCache = false;
  private remoteHome: string | null = null;
  private apiSequence = 0;
  private controlConnect: Promise<void> | null = null;
  private controlReconnect: Promise<void> | null = null;
  private localForwards = new Map<number, SSHClient>();
  private remoteHtmlPreviews = new Map<number, RemoteHtmlPreviewProcess>();
  private remoteHtmlPreviewSequence = 0;
  private remoteSftpFileServers = new Map<number, SSHClient>();

  async connect(profile: ConnectionProfile, jumpProfiles: ConnectionProfile[] = []): Promise<void> {
    const port = Number(profile.port);
    this.validateSshPort(port);
    jumpProfiles.forEach(jumpProfile => this.validateSshPort(Number(jumpProfile.port)));

    if (this.controlConnect) return this.controlConnect;
    const task = (async () => {
      this.client = await this.connectSsh(profile, port, jumpProfiles);
      this.profile = profile;
      this.jumpProfiles = jumpProfiles;
      this.apiServer = null;
      this.resolvedApiSocketPath = profile.herdrSocketPath?.trim() ? null : cachedApiSocketPath(profile);
      this.resolvedApiSocketPathFromCache = Boolean(this.resolvedApiSocketPath);
      this.remoteHome = null;
    })();
    this.controlConnect = task;
    try {
      await task;
    } finally {
      if (this.controlConnect === task) this.controlConnect = null;
    }
  }

  /** Replace the single authenticated SSH session and recreate its channels. */
  async reconnectControl(profile: ConnectionProfile = this.requireProfile()): Promise<void> {
    const connecting = this.controlConnect;
    if (connecting) {
      try {
        await connecting;
        return;
      } catch {
        // The initial handshake failed, so continue with the normal reconnect.
      }
    }
    if (this.controlReconnect) return this.controlReconnect;
    const task = this.replaceControlConnection(profile);
    this.controlReconnect = task;
    try {
      await task;
    } finally {
      if (this.controlReconnect === task) this.controlReconnect = null;
    }
  }

  private async replaceControlConnection(profile: ConnectionProfile): Promise<void> {
    const port = Number(profile.port);
    this.validateSshPort(port);

    const nextClient = await this.connectSsh(profile, port, this.jumpProfiles);
    const previousClient = this.client;
    const retainedEventSubscription = this.eventSubscription;
    this.closeEventTransport();
    this.client = nextClient;
    this.profile = profile;
    this.apiServer = null;
    this.resolvedApiSocketPath = profile.herdrSocketPath?.trim() ? null : cachedApiSocketPath(profile);
    this.resolvedApiSocketPathFromCache = Boolean(this.resolvedApiSocketPath);
    this.remoteHome = null;
    const retainedTerminalIds = [...this.terminalBridges];
    this.clearAllTerminalBridgeState();
    this.terminalOpenings.clear();
    previousClient?.off('Shell');
    if (previousClient) this.disconnectSsh(previousClient);
    for (const [localPort, tunnelClient] of this.localForwards) {
      if (tunnelClient === previousClient) this.localForwards.delete(localPort);
    }

    // A control reconnect is transport maintenance, not a terminal failure.
    // Restore every open terminal channel on the replacement SSH session while
    // preserving each terminal's frame and close callbacks.
    for (const terminalId of retainedTerminalIds) {
      try {
        await this.attachTerminal(terminalId);
      } catch (error) {
        this.terminalConnections.get(terminalId)?.onClosed?.(`Terminal reattach failed: ${String(error)}`);
      }
    }

    if (retainedEventSubscription && this.eventSubscription === retainedEventSubscription) {
      try {
        await this.startEventSubscription(retainedEventSubscription);
      } catch (error) {
        if (this.eventSubscription === retainedEventSubscription) {
          this.eventSubscription = null;
          this.closeEventTransport();
          retainedEventSubscription.onClosed?.(String(error));
        }
      }
    }
  }

  disconnect(): void {
    this.closeEventStream();
    for (const terminalId of this.sshShellConnections.keys()) {
      this.closeSshShell(terminalId);
    }
    this.client?.closeAllHerdrBridges();
    this.client?.off('Shell');
    if (this.client) this.disconnectSsh(this.client);
    this.client = null;
    this.profile = null;
    this.jumpProfiles = [];
    this.apiServer = null;
    this.resolvedApiSocketPath = null;
    this.resolvedApiSocketPathFromCache = false;
    this.remoteHome = null;
    this.terminalOpenings.clear();
    this.terminalConnections.clear();
    this.terminalSizes.clear();
    this.clearAllTerminalBridgeState();
    this.controlReconnect = null;
    this.localForwards.clear();
    this.remoteHtmlPreviews.clear();
    this.remoteSftpFileServers.clear();
  }

  async openWebTunnel(value: string): Promise<{ url: string; localPort: number } | null> {
    const target = terminalWebLinkTarget(value);
    if (!target.requiresSshTunnel) return null;
    const client = this.requireClient();
    const localPort = await client.openLocalForward(target.hostname, target.port);
    this.localForwards.set(localPort, client);
    return { url: localTunnelUrl(target.url, localPort), localPort };
  }

  async closeWebTunnel(localPort: number): Promise<void> {
    const client = this.localForwards.get(localPort);
    this.localForwards.delete(localPort);
    const preview = this.remoteHtmlPreviews.get(localPort);
    this.remoteHtmlPreviews.delete(localPort);
    if (preview) {
      await preview.client.execute(remoteHtmlPreviewStopCommand(preview)).catch(() => undefined);
    }
    if (client) await client.closeLocalForward(localPort);
  }

  async openRemoteHtmlPreview(remotePath: string): Promise<RemoteHtmlPreviewHandle> {
    const client = this.requireClient();
    const normalizedPath = remotePath.replace(/\\/g, '/');
    const separator = normalizedPath.lastIndexOf('/');
    const directory = separator > 0 ? normalizedPath.slice(0, separator) : '/';
    const filename = normalizedPath.slice(separator + 1);
    if (!filename) throw new Error('The remote HTML preview path has no filename');

    const token = `${Date.now().toString(36)}-${(++this.remoteHtmlPreviewSequence).toString(36)}`;
    const output = await client.execute(remoteHtmlPreviewStartCommand(directory, token));
    const process = parseRemoteHtmlPreviewStart(output, token);
    let localPort: number | null = null;
    try {
      localPort = await client.openLocalForward('127.0.0.1', process.port);
      this.localForwards.set(localPort, client);
      this.remoteHtmlPreviews.set(localPort, { ...process, client });
      const displayUrl = remoteHtmlPreviewPageUrl(process.port, filename);
      return {
        displayUrl,
        localPort,
        url: localTunnelUrl(displayUrl, localPort),
      };
    } catch (error) {
      if (localPort !== null) {
        this.localForwards.delete(localPort);
        await client.closeLocalForward(localPort).catch(() => undefined);
      }
      await client.execute(remoteHtmlPreviewStopCommand(process)).catch(() => undefined);
      throw error;
    }
  }

  closeRemoteHtmlPreview(preview: RemoteHtmlPreviewHandle): Promise<void> {
    return this.closeWebTunnel(preview.localPort);
  }

  async openRemoteSftpFileServer(remotePath: string): Promise<RemoteSftpFileServerHandle> {
    const client = this.requireClient();
    const server = await client.startSftpFileServer(remotePath);
    const filename = remotePath.replace(/\\/g, '/').split('/').pop() || 'file';
    this.remoteSftpFileServers.set(server.localPort, client);
    return {
      localPort: server.localPort,
      url: `http://127.0.0.1:${server.localPort}/${server.token}/${encodeURIComponent(filename)}`,
    };
  }

  async closeRemoteSftpFileServer(server: RemoteSftpFileServerHandle): Promise<void> {
    const client = this.remoteSftpFileServers.get(server.localPort);
    this.remoteSftpFileServers.delete(server.localPort);
    if (client) await client.closeSftpFileServer(server.localPort);
  }

  async listRemoteDirectory(path?: string): Promise<{ path: string; entries: LsResult[] }> {
    const resolvedPath = normalizeRemotePath(path, await this.remoteHomeDirectory());
    const entries = await this.requireClient().sftpLs(resolvedPath);
    return { path: resolvedPath, entries: sortRemoteEntries(entries) };
  }

  async discoverRemoteGitRepository(path: string): Promise<RemoteGitRepository | null> {
    const output = await this.requireClient().execute(remoteGitRepositoryCommand(path));
    return parseRemoteGitRepository(output);
  }

  async listRemoteGitChanges(root: string): Promise<RemoteGitStatusEntry[]> {
    const output = await this.requireClient().execute(remoteGitStatusCommand(root));
    return parseRemoteGitStatus(output);
  }

  async loadRemoteGitDiff(repository: RemoteGitRepository, status: RemoteGitStatusEntry): Promise<RemoteGitDiff> {
    const output = await this.requireClient().execute(remoteGitDiffCommand(repository, status));
    return parseRemoteGitDiff(output);
  }

  downloadRemoteFile(path: string, localDirectoryPath: string): Promise<string> {
    return this.requireClient().sftpDownload(path, localDirectoryPath);
  }

  uploadRemoteFile(localFilePath: string, remoteDirectoryPath: string): Promise<void> {
    return this.requireClient().sftpUpload(localFilePath, remoteDirectoryPath);
  }

  deleteRemoteEntry(path: string, isDirectory: boolean): Promise<void> {
    const client = this.requireClient();
    return isDirectory ? client.sftpRmdir(path) : client.sftpRm(path);
  }

  async uploadTerminalAttachment(localFilePath: string): Promise<string> {
    const client = this.requireClient();
    const sourceFilename = localFilePath.replace(/\\/g, '/').split('/').pop();
    if (!sourceFilename) throw new Error('The selected attachment has no filename');
    const home = await this.remoteHomeDirectory();
    const appDirectory = `${home}/.whip`;
    const uploadDirectory = `${appDirectory}/uploads`;
    for (const directory of [appDirectory, uploadDirectory]) {
      try {
        await client.sftpMkdir(directory);
      } catch {
        // mkdir reports an error when the directory already exists. Listing it
        // distinguishes that harmless case from a real permissions/path error.
        await client.sftpLs(directory);
      }
    }
    const uploadId = createSecureId('attachment');
    const stagingDirectory = `${uploadDirectory}/.${uploadId}.upload`;
    const stagingPath = `${stagingDirectory}/${sourceFilename}`;
    const remoteFilename = uniqueRemoteAttachmentName(sourceFilename, uploadId);
    const remotePath = `${uploadDirectory}/${remoteFilename}`;
    let stagingCreated = false;
    let promoted = false;
    try {
      await client.sftpMkdir(stagingDirectory);
      stagingCreated = true;
      // react-native-russh currently expects a remote directory here and
      // appends the local basename. Rename afterward to the exact unique path.
      await client.sftpUpload(localFilePath, stagingDirectory);
      await client.sftpRename(stagingPath, remotePath);
      promoted = true;
      const entries = await client.sftpLs(uploadDirectory);
      const uploaded = entries.find(entry => remoteEntryName(entry) === remoteFilename);
      if (!uploaded || Boolean(uploaded.isDirectory)) {
        throw new Error(`Uploaded attachment was not found at ${remotePath}`);
      }
      return remotePath;
    } catch (error) {
      if (promoted) await client.sftpRm(remotePath).catch(() => undefined);
      else if (stagingCreated) await client.sftpRm(stagingPath).catch(() => undefined);
      throw error;
    } finally {
      if (stagingCreated) await client.sftpRmdir(stagingDirectory).catch(() => undefined);
    }
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

    const reconnecting = this.controlReconnect;
    if (reconnecting) await reconnecting;

    const opening = this.terminalOpenings.get(terminalId);
    if (opening) {
      await opening;
      return;
    }

    const task = this.attachTerminal(terminalId);
    this.terminalOpenings.set(terminalId, task);
    try {
      await task;
    } finally {
      this.terminalOpenings.delete(terminalId);
    }
  }

  async writeToTerminal(terminalId: string, data: string): Promise<string> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening;
    if (isSshShellTerminalId(terminalId)) {
      return this.requireSshShell(terminalId).client.writeToShell(data);
    }
    await this.ensureTerminalBridge(terminalId);
    await this.requireClient().herdrBridgeInput(terminalId, data);
    return '';
  }

  async clickTerminal(terminalId: string, column: number, row: number): Promise<void> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening;
    if (isSshShellTerminalId(terminalId)) return;
    await this.ensureTerminalBridge(terminalId);
    const sgrColumn = Math.max(0, Math.min(0xffff, Math.round(column))) + 1;
    const sgrRow = Math.max(0, Math.min(0xffff, Math.round(row))) + 1;
    await this.requireClient().herdrBridgeInput(
      terminalId,
      `\u001b[<0;${sgrColumn};${sgrRow}M\u001b[<0;${sgrColumn};${sgrRow}m`,
    );
  }

  resizeTerminal(terminalId: string, columns: number, rows: number, cellWidthPx = 0, cellHeightPx = 0): void {
    const size = {
      columns: Math.max(20, columns),
      rows: Math.max(8, rows),
      cellWidthPx: Math.max(0, Math.round(cellWidthPx)),
      cellHeightPx: Math.max(0, Math.round(cellHeightPx)),
    };
    this.terminalSizes.set(terminalId, size);
    const sshShell = this.sshShellConnections.get(terminalId);
    if (sshShell) {
      sshShell.client.resizeShell(size.columns, size.rows);
      return;
    }
    if (this.terminalBridges.has(terminalId)) {
      this.requireClient()
        .herdrBridgeResize(terminalId, size.columns, size.rows, size.cellWidthPx, size.cellHeightPx)
        .catch(() => {});
    }
  }

  async scrollTerminal(
    terminalId: string,
    direction: 'up' | 'down',
    lines: number,
    column?: number,
    row?: number,
  ): Promise<string> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening;
    if (isSshShellTerminalId(terminalId)) return '';
    await this.ensureTerminalBridge(terminalId);
    await this.requireClient().herdrBridgeScroll(
      terminalId,
      direction,
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
    this.client?.closeHerdrBridge(terminalId);
  }

  isTerminalBridgeRetained(terminalId: string): boolean {
    return this.terminalBridges.has(terminalId) || this.sshShellConnections.has(terminalId) || this.terminalOpenings.has(terminalId);
  }

  async releaseTerminal(terminalId: string): Promise<void> {
    if (isSshShellTerminalId(terminalId)) {
      const opening = this.terminalOpenings.get(terminalId);
      if (opening) await opening.catch(() => undefined);
      this.closeSshShell(terminalId);
      return;
    }
    const connection = this.terminalConnections.get(terminalId);
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);

    // A reconnect may have installed a new callback while the old bridge was
    // still opening. In that case this is a stale effect cleanup and must not
    // detach the replacement controller.
    if (this.terminalConnections.get(terminalId) !== connection) return;

    this.terminalConnections.delete(terminalId);
    this.clearTerminalBridgeState(terminalId);
    this.client?.closeHerdrBridge(terminalId);
  }

  async detachTerminal(terminalId: string): Promise<void> {
    if (isSshShellTerminalId(terminalId)) {
      this.closeSshShell(terminalId);
      return;
    }
    const connection = this.terminalConnections.get(terminalId);
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);

    // Do not detach a replacement controller installed while this renderer was
    // unmounting. The SSH bridge remains open until the terminal or host closes.
    if (this.terminalConnections.get(terminalId) !== connection) return;
    this.terminalConnections.delete(terminalId);
  }

  async closeTerminalBridge(terminalId: string): Promise<void> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);
    if (isSshShellTerminalId(terminalId)) {
      this.closeSshShell(terminalId);
      this.terminalOpenings.delete(terminalId);
      this.terminalSizes.delete(terminalId);
      return;
    }
    this.terminalConnections.delete(terminalId);
    this.terminalOpenings.delete(terminalId);
    this.terminalSizes.delete(terminalId);
    this.clearTerminalBridgeState(terminalId);
    this.client?.closeHerdrBridge(terminalId);
  }

  async releaseAllTerminals(): Promise<void> {
    for (const terminalId of this.sshShellConnections.keys()) {
      this.closeSshShell(terminalId);
    }
    this.terminalConnections.clear();
    this.terminalOpenings.clear();
    this.clearAllTerminalBridgeState();
    this.client?.closeAllHerdrBridges();
  }

  async snapshot(): Promise<HerdrSnapshot> {
    // A stopped server can be started independently after this SSH connection
    // was opened. Only cache a usable API endpoint so refreshes can discover it.
    const server = this.apiServer?.running ? this.apiServer : await this.probeServer();
    this.apiServer = server.running ? server : null;
    if (!server.running) {
      return this.offlineSnapshot(server);
    }
    assertHerdrProtocolCompatible(server.protocol, server.compatible !== false);
    if (!server.socket) throw new Error('Herdr server status did not include its API socket');
    try {
      return await this.requestSessionSnapshot(server.socket);
    } catch (error) {
      this.apiServer = null;
      throw error;
    }
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
    let socket = await this.apiSocketPath();
    try {
      return await this.requestSessionSnapshot(socket);
    } catch (error) {
      if (!isUnavailableSshChannel(error)) throw error;
    }

    // A cached absolute path may have become stale after an account or home
    // directory change. Resolve it once through the current SSH session before
    // treating the Herdr socket as unavailable.
    if (this.resolvedApiSocketPathFromCache) {
      this.invalidateCachedApiSocketPath();
      socket = await this.apiSocketPath();
    }

    try {
      return await this.requestSessionSnapshot(socket);
    } catch (error) {
      if (!isUnavailableSshChannel(error)) throw error;
      this.apiServer = null;
      return this.offlineSnapshot({ running: false, socket });
    }
  }

  private async requestSessionSnapshot(socket: string): Promise<HerdrSnapshot> {
    const result = await this.apiRequest<SessionSnapshotResult>('session.snapshot', {}, socket);
    if (!result || result.type !== 'session_snapshot' || !result.snapshot) {
      throw new Error('Herdr API socket did not return a session snapshot');
    }
    const snapshot = result.snapshot;
    assertHerdrProtocolCompatible(snapshot.protocol);
    const server: ServerInfo = {
      running: true,
      version: snapshot.version,
      protocol: snapshot.protocol,
      compatible: true,
      socket,
    };
    this.apiServer = server;
    return {
      server,
      focused_workspace_id: snapshot.focused_workspace_id ?? null,
      focused_tab_id: snapshot.focused_tab_id ?? null,
      focused_pane_id: snapshot.focused_pane_id ?? null,
      agents: snapshot.agents,
      workspaces: snapshot.workspaces,
      tabs: snapshot.tabs,
      panes: snapshot.panes,
      layouts: snapshot.layouts ?? [],
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

  async openEventStream(paneIds: string[], onEvent: ApiEventHandler, onClosed?: TerminalClosedHandler): Promise<void> {
    this.closeEventStream();
    const subscription = { paneIds: [...paneIds], onEvent, onClosed };
    this.eventSubscription = subscription;
    try {
      await this.startEventSubscription(subscription);
    } catch (error) {
      if (this.eventSubscription === subscription) {
        this.eventSubscription = null;
        this.closeEventTransport();
      }
      throw error;
    }
  }

  private async startEventSubscription(subscription: EventSubscription): Promise<void> {
    const server = await this.requireBridgeServer();
    this.apiServer = server;
    if (!server.running || !server.socket) throw new Error('Herdr API socket is not available');
    const generation = ++this.eventGeneration;
    const client = this.requireClient();
    if (generation !== this.eventGeneration) {
      return;
    }
    const decoder = new HerdrApiBridgeDecoder();
    const close = (reason?: string) => {
      if (generation !== this.eventGeneration) return;
      if (this.eventSubscription === subscription) this.eventSubscription = null;
      this.closeEventTransport();
      subscription.onClosed?.(reason);
    };
    const onData = (data: string) => {
      for (const message of decoder.push(data)) {
        const error = apiErrorMessage(message);
        const event = apiEvent(message);
        if (error) {
          close(error);
        } else if (event) {
          subscription.onEvent(event);
        } else if ((message as { herdr_android_bridge_closed?: boolean }).herdr_android_bridge_closed) {
          const reason = (message as { reason?: unknown }).reason;
          close(typeof reason === 'string' && reason.trim()
            ? `Herdr event bridge closed: ${reason}`
            : 'Herdr event bridge closed');
        }
      }
    };
    try {
      await client.startHerdrEventStream(server.socket, onData);
      if (generation !== this.eventGeneration || this.eventSubscription !== subscription) {
        client.closeHerdrEventStream();
        throw new Error('Herdr event stream closed during startup');
      }
      this.eventClient = client;
      await client.writeHerdrEventStream(apiRequestLine(eventsSubscribeRequest(subscription.paneIds)));
    } catch (error) {
      if (this.eventClient === client) this.eventClient = null;
      client.closeHerdrEventStream();
      throw error;
    }
  }

  closeEventStream(): void {
    this.eventSubscription = null;
    this.closeEventTransport();
  }

  private closeEventTransport(): void {
    this.eventGeneration += 1;
    const client = this.eventClient;
    this.eventClient = null;
    client?.closeHerdrEventStream();
  }

  /** Measure device-to-host RTT without including SSH or snapshot work. */
  async measureLatency(): Promise<number> {
    const latencyMs = await this.requireClient().measureHostLatency();
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
      throw new Error('Android returned an invalid host latency');
    }
    return Math.round(latencyMs);
  }

  async startServer(): Promise<void> {
    const command = `nohup ${this.baseCommand()} server >/tmp/whip-herdr-server.log 2>&1 </dev/null &`;
    await this.requireClient().execute(this.loginShellCommand(command));
    this.apiServer = null;
  }

  readPane(paneId: string): Promise<string> {
    return this.apiRequest<{ type: 'pane_read'; read: { text: string } }>('pane.read', {
      pane_id: paneId,
      source: 'recent',
      lines: 160,
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

  async startAgent(workspaceId: string, name: string, command: string): Promise<string> {
    const label = name.trim();
    const created = await this.apiRequest<{
      type: 'tab_created';
      root_pane: { pane_id: string };
    }>('tab.create', {
      workspace_id: workspaceId,
      ...(label ? { label } : {}),
      focus: true,
    });
    if (label) {
      await this.apiRequest('pane.rename', {
        pane_id: created.root_pane.pane_id,
        label,
      });
    }
    await this.apiRequest('pane.send_input', {
      pane_id: created.root_pane.pane_id,
      text: command.trim(),
      keys: ['Enter'],
    });
    return created.root_pane.pane_id;
  }

  async runCommand(workspaceId: string, name: string, command: string): Promise<string> {
    return this.startAgent(workspaceId, name, command);
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.apiFocus('workspace.focus', { workspace_id: workspaceId });
  }

  async createWorkspace(label: string, cwd: string): Promise<void> {
    await this.apiRequest('workspace.create', {
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

  async createTab(workspaceId: string, label: string): Promise<void> {
    await this.apiRequest('tab.create', {
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
      keys: ['Enter'],
    });
  }

  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    await this.apiRequest('pane.send_keys', { pane_id: paneId, keys });
  }

  private async apiFocus<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const reconnecting = this.controlReconnect;
    if (reconnecting) await reconnecting;
    try {
      return await this.apiRequest<T>(method, params);
    } catch (error) {
      if (!isUnavailableSshChannel(error)) throw error;
      await this.reconnectControl();
      return this.apiRequest<T>(method, params);
    }
  }

  private async apiRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, socketPath?: string): Promise<T> {
    const request: HerdrApiRequest = {
      id: `android_${++this.apiSequence}`,
      method,
      params,
    };
    const response = await this.requireClient().requestHerdrApi(socketPath ?? (await this.apiSocketPath()), apiRequestLine(request));
    let message: HerdrApiMessage;
    try {
      message = JSON.parse(response) as HerdrApiMessage;
    } catch {
      throw new Error('Herdr API returned invalid JSON');
    }
    const error = apiErrorMessage(message);
    if (error) throw new Error(error);
    if (!Object.prototype.hasOwnProperty.call(message, 'result')) {
      throw new Error('Herdr API response did not include a result');
    }
    return message.result as T;
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
    const remoteHome = await this.remoteHomeDirectory();
    const dataDir = profile.sessionName.trim() ? `${remoteHome}/.config/herdr/sessions/${profile.sessionName.trim()}` : `${remoteHome}/.config/herdr`;
    const socketPath = `${dataDir}/herdr.sock`;
    this.resolvedApiSocketPath = socketPath;
    this.resolvedApiSocketPathFromCache = false;
    apiSocketPathCache.set(profile.id, {
      fingerprint: apiSocketPathFingerprint(profile),
      socketPath,
    });
    return socketPath;
  }

  private invalidateCachedApiSocketPath(): void {
    if (!this.resolvedApiSocketPathFromCache) return;
    const profile = this.requireProfile();
    const cached = apiSocketPathCache.get(profile.id);
    if (cached?.socketPath === this.resolvedApiSocketPath) {
      apiSocketPathCache.delete(profile.id);
    }
    this.resolvedApiSocketPath = null;
    this.resolvedApiSocketPathFromCache = false;
    this.remoteHome = null;
  }

  private async remoteHomeDirectory(): Promise<string> {
    if (!this.remoteHome) this.remoteHome = await this.requireClient().getRemoteHome();
    return this.remoteHome;
  }

  private async clientSocketPath(): Promise<string> {
    const apiSocket = await this.apiSocketPath();
    return apiSocket.endsWith('.sock') ? `${apiSocket.slice(0, -5)}-client.sock` : `${apiSocket}-client`;
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
      await this.requireClient().getRemoteHome();
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
    const command = shellQuote(profile.herdrCommand.trim() || 'herdr');
    return profile.sessionName.trim() ? `${command} --session ${shellQuote(profile.sessionName.trim())}` : command;
  }

  private requireClient(): SSHClient {
    if (!this.client) {
      throw new Error('SSH connection is not active');
    }
    return this.client;
  }

  private requireProfile(): ConnectionProfile {
    if (!this.profile) {
      throw new Error('SSH connection is not active');
    }
    return this.profile;
  }

  private async connectSsh(profile: ConnectionProfile, port = Number(profile.port), jumpProfiles = this.jumpProfiles): Promise<SSHClient> {
    const proxyClients: SSHClient[] = [];
    let proxyClient: SSHClient | null = null;

    try {
      for (const jumpProfile of jumpProfiles) {
        const jumpPort = Number(jumpProfile.port);
        this.validateSshPort(jumpPort);
        proxyClient = await this.connectDirectSsh(jumpProfile, jumpProfile.host.trim(), jumpPort, proxyClient);
        proxyClients.push(proxyClient);
      }

      const client = await this.connectDirectSsh(profile, profile.host.trim(), port, proxyClient);
      if (proxyClients.length > 0) this.proxyClients.set(client, proxyClients);
      return client;
    } catch (error) {
      [...proxyClients].reverse().forEach(client => client.disconnect());
      throw error;
    }
  }

  private connectDirectSsh(profile: ConnectionProfile, host: string, port: number, jumpClient: SSHClient | null = null): Promise<SSHClient> {
    const privateKey = normalizePrivateKey(profile.secret);
    const connection =
      profile.authMode === 'password'
        ? jumpClient
          ? SSHClient.connectWithPasswordViaJump(host, port, profile.username.trim(), profile.secret, jumpClient)
          : SSHClient.connectWithPassword(host, port, profile.username.trim(), profile.secret)
        : jumpClient
        ? SSHClient.connectWithKeyViaJump(host, port, profile.username.trim(), privateKey, profile.passphrase || undefined, jumpClient)
        : SSHClient.connectWithKey(host, port, profile.username.trim(), privateKey, profile.passphrase || undefined);
    return connection.then(client => {
      if (profile.forwardAgent) client.setAgentForwarding(true);
      return client;
    });
  }

  private disconnectSsh(client: SSHClient): void {
    client.disconnect();
    const proxyClients = this.proxyClients.get(client);
    this.proxyClients.delete(client);
    if (proxyClients) {
      [...proxyClients].reverse().forEach(proxyClient => proxyClient.disconnect());
    }
  }

  private validateSshPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be between 1 and 65535');
    }
  }

  private async createSshShell(terminalId: string, onFrame: TerminalFrameHandler, onClosed?: TerminalClosedHandler): Promise<void> {
    const client = await this.connectSsh(this.requireProfile());
    const connection: SshShellConnection = {
      client,
      onFrame,
      onClosed,
      sequence: 0,
    };
    const onData = (data: string) => {
      const active = this.sshShellConnections.get(terminalId);
      if (active !== connection) return;
      const size = this.terminalSizes.get(terminalId) || DEFAULT_TERMINAL_SIZE;
      active.onFrame({
        type: 'terminal.frame',
        seq: ++active.sequence,
        encoding: 'utf8',
        width: size.columns,
        height: size.rows,
        full: false,
        bytes: data,
      });
    };
    this.sshShellConnections.set(terminalId, connection);
    try {
      client.on('Shell', onData);
      await client.startShell(PtyType.XTERM);
      const size = this.terminalSizes.get(terminalId) || DEFAULT_TERMINAL_SIZE;
      client.resizeShell(size.columns, size.rows);
    } catch (error) {
      this.closeSshShell(terminalId);
      throw error;
    }
  }

  private closeSshShell(terminalId: string): void {
    const connection = this.sshShellConnections.get(terminalId);
    if (!connection) return;
    this.sshShellConnections.delete(terminalId);
    connection.client.off('Shell');
    connection.client.closeShell();
    this.disconnectSsh(connection.client);
  }

  private requireSshShell(terminalId: string): SshShellConnection {
    const connection = this.sshShellConnections.get(terminalId);
    if (!connection) throw new Error(`SSH shell ${terminalId} is not connected`);
    return connection;
  }

  private async attachTerminal(terminalId: string): Promise<void> {
    const size = this.terminalSizes.get(terminalId) || DEFAULT_TERMINAL_SIZE;
    await this.ensureTerminalBridge(terminalId, size);
    await this.requireClient().herdrBridgeResize(terminalId, size.columns, size.rows, size.cellWidthPx, size.cellHeightPx);
  }

  private async ensureTerminalBridge(terminalId: string, requestedSize?: TerminalSize): Promise<void> {
    if (this.terminalBridges.has(terminalId)) return;
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) return opening;
    const size = requestedSize || this.terminalSizes.get(terminalId) || DEFAULT_TERMINAL_SIZE;
    const server = await this.requireBridgeServer();
    const generation = ++this.terminalBridgeSequence;
    this.terminalBridgeGenerations.set(terminalId, generation);
    this.updateTerminalProtocolState(terminalId, {
      kittyKeyboardReportAll: false,
    });
    try {
      await this.requireClient().startHerdrBridge(await this.clientSocketPath(), server.protocol, terminalId, true, size.columns, size.rows, size.cellWidthPx, size.cellHeightPx, event => this.handleHerdrBridgeEvent(terminalId, generation, event));
    } catch (error) {
      if (this.terminalBridgeGenerations.get(terminalId) === generation) {
        this.terminalBridgeGenerations.delete(terminalId);
      }
      throw error;
    }
    this.terminalBridges.add(terminalId);
  }

  private async requireBridgeServer(): Promise<ServerInfo & { protocol: number }> {
    const server = this.apiServer || (await this.probeServer());
    this.apiServer = server;
    if (!server.running || typeof server.protocol !== 'number') {
      throw new Error('Herdr server protocol is unavailable');
    }
    assertHerdrProtocolCompatible(server.protocol, server.compatible !== false);
    return server as ServerInfo & { protocol: number };
  }

  private handleHerdrBridgeEvent(terminalId: string, generation: number, event: HerdrBridgeEvent): void {
    if (this.terminalBridgeGenerations.get(terminalId) !== generation) return;
    if (event.type === 'terminal') {
      if (typeof event.seq === 'number' && typeof event.width === 'number' && typeof event.height === 'number' && (typeof event.bytes === 'string' || event.bytes instanceof ArrayBuffer || ArrayBuffer.isView(event.bytes))) {
        this.terminalConnections.get(terminalId)?.onFrame({
          type: 'terminal.frame',
          seq: event.seq,
          encoding: 'ansi',
          width: event.width,
          height: event.height,
          full: Boolean(event.full),
          bytes: event.bytes,
          final: event.final !== false,
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
    this.terminalBridges.delete(terminalId);
    this.terminalBridgeGenerations.delete(terminalId);
    this.terminalProtocolStates.delete(terminalId);
  }

  private clearAllTerminalBridgeState(): void {
    this.terminalBridges.clear();
    this.terminalBridgeGenerations.clear();
    this.terminalProtocolStates.clear();
  }
}
