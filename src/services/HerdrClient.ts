import SSHClient, {
  type HerdrBridgeEvent,
  type LsResult,
} from '@dylankenneally/react-native-ssh-sftp';

import { normalizePrivateKey } from '../lib/privateKey';
import { normalizeRemotePath, sortRemoteEntries } from '../lib/remoteFiles';
import { assertHerdrProtocolCompatible } from '../lib/herdrProtocol';
import {
  apiEvent,
  apiErrorMessage,
  apiRequestLine,
  eventsSubscribeRequest,
  HerdrApiBridgeDecoder,
  type HerdrApiEvent,
  type HerdrApiMessage,
  type HerdrApiRequest,
  type SessionSnapshotResult,
} from '../lib/herdrApiBridge';
import { shellQuote } from '../lib/shell';
import {
  type TerminalFrame,
} from '../lib/terminalBridge';
import { localTunnelUrl, terminalWebLinkTarget } from '../lib/terminalLinks';
import type { ConnectionProfile, HerdrSnapshot, ServerInfo } from '../types';

type TerminalFrameHandler = (frame: TerminalFrame) => void;
type TerminalClosedHandler = (reason?: string) => void;
type ApiEventHandler = (event: HerdrApiEvent) => void;

export function isUnavailableSshChannel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /channel (?:is )?not open(?:ed)?|session is down|socket is not established/i.test(message);
}

interface TerminalConnection {
  onFrame: TerminalFrameHandler;
  onClosed?: TerminalClosedHandler;
}

interface TerminalSize {
  columns: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}

export const MAX_RETAINED_TERMINAL_BRIDGES = 3;

export class HerdrClient {
  private client: SSHClient | null = null;
  private profile: ConnectionProfile | null = null;
  private terminalConnections = new Map<string, TerminalConnection>();
  private terminalOpenings = new Map<string, Promise<void>>();
  private terminalSizes = new Map<string, TerminalSize>();
  private terminalBridges = new Set<string>();
  private terminalBridgeLru = new Map<string, true>();
  private eventClient: SSHClient | null = null;
  private eventGeneration = 0;
  private apiServer: ServerInfo | null = null;
  private remoteHome: string | null = null;
  private apiSequence = 0;
  private controlConnect: Promise<void> | null = null;
  private controlReconnect: Promise<void> | null = null;
  private localForwards = new Map<number, SSHClient>();

  async connect(profile: ConnectionProfile): Promise<void> {
    const port = Number(profile.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be between 1 and 65535');
    }

    if (this.controlConnect) return this.controlConnect;
    const task = (async () => {
      this.client = await this.connectSsh(profile, port);
      this.profile = profile;
      this.apiServer = null;
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
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be between 1 and 65535');
    }

    const nextClient = await this.connectSsh(profile, port);
    const previousClient = this.client;
    this.client = nextClient;
    this.profile = profile;
    this.apiServer = null;
    this.eventClient = null;
    const retainedTerminalIds = [...this.terminalBridgeLru.keys()].filter(terminalId => (
      this.terminalBridges.has(terminalId)
    ));
    this.terminalBridges.clear();
    this.terminalBridgeLru.clear();
    this.terminalOpenings.clear();
    previousClient?.off('Shell');
    previousClient?.disconnect();
    for (const [localPort, tunnelClient] of this.localForwards) {
      if (tunnelClient === previousClient) this.localForwards.delete(localPort);
    }

    // A control reconnect is transport maintenance, not a terminal failure.
    // Restore only the bounded LRU set on the replacement SSH session while
    // preserving each terminal's frame and close callbacks.
    for (const terminalId of retainedTerminalIds) {
      try {
        await this.attachTerminal(terminalId);
      } catch (error) {
        this.terminalConnections.get(terminalId)?.onClosed?.(
          `Terminal reattach failed: ${String(error)}`,
        );
      }
    }
  }

  disconnect(): void {
    this.closeEventStream();
    this.client?.closeAllHerdrBridges();
    this.client?.off('Shell');
    this.client?.disconnect();
    this.client = null;
    this.profile = null;
    this.apiServer = null;
    this.remoteHome = null;
    this.terminalOpenings.clear();
    this.terminalConnections.clear();
    this.terminalSizes.clear();
    this.terminalBridges.clear();
    this.terminalBridgeLru.clear();
    this.controlReconnect = null;
    this.localForwards.clear();
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
    if (client) await client.closeLocalForward(localPort);
  }

  async listRemoteDirectory(path?: string): Promise<{ path: string; entries: LsResult[] }> {
    const resolvedPath = normalizeRemotePath(path, await this.remoteHomeDirectory());
    const entries = await this.requireClient().sftpLs(resolvedPath);
    return { path: resolvedPath, entries: sortRemoteEntries(entries) };
  }

  downloadRemoteFile(path: string, localDirectoryPath: string): Promise<string> {
    return this.requireClient().sftpDownload(path, localDirectoryPath);
  }

  uploadRemoteFile(localFilePath: string, remoteDirectoryPath: string): Promise<void> {
    return this.requireClient().sftpUpload(localFilePath, remoteDirectoryPath);
  }

  async uploadTerminalAttachment(localFilePath: string): Promise<string> {
    const client = this.requireClient();
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
    await client.sftpUpload(localFilePath, uploadDirectory);
    const filename = localFilePath.replace(/\\/g, '/').split('/').pop();
    if (!filename) throw new Error('The selected attachment has no filename');
    return `${uploadDirectory}/${filename}`;
  }

  async openTerminal(
    terminalId: string,
    onFrame: TerminalFrameHandler,
    onClosed?: TerminalClosedHandler,
  ): Promise<void> {
    this.terminalConnections.set(terminalId, { onFrame, onClosed });

    const reconnecting = this.controlReconnect;
    if (reconnecting) await reconnecting;

    const opening = this.terminalOpenings.get(terminalId);
    if (opening) {
      await opening;
      this.touchTerminalBridge(terminalId);
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
    await this.ensureTerminalBridge(terminalId);
    await this.requireClient().herdrBridgeInput(terminalId, data);
    return '';
  }

  resizeTerminal(
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx = 0,
    cellHeightPx = 0,
  ): void {
    const size = {
      columns: Math.max(20, columns),
      rows: Math.max(8, rows),
      cellWidthPx: Math.max(0, Math.round(cellWidthPx)),
      cellHeightPx: Math.max(0, Math.round(cellHeightPx)),
    };
    this.terminalSizes.set(terminalId, size);
    if (this.terminalBridges.has(terminalId)) {
      this.requireClient().herdrBridgeResize(
        terminalId,
        size.columns,
        size.rows,
        size.cellWidthPx,
        size.cellHeightPx,
      ).catch(() => {});
    }
  }

  async scrollTerminal(terminalId: string, direction: 'up' | 'down', lines: number): Promise<string> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening;
    await this.ensureTerminalBridge(terminalId);
    await this.requireClient().herdrBridgeScroll(terminalId, direction, Math.max(1, Math.round(lines)));
    return '';
  }

  closeTerminal(terminalId: string): void {
    this.terminalConnections.delete(terminalId);
    this.terminalBridges.delete(terminalId);
    this.terminalBridgeLru.delete(terminalId);
    this.client?.closeHerdrBridge(terminalId);
  }

  isTerminalBridgeRetained(terminalId: string): boolean {
    return this.terminalBridges.has(terminalId) || this.terminalOpenings.has(terminalId);
  }

  async releaseTerminal(terminalId: string): Promise<void> {
    const connection = this.terminalConnections.get(terminalId);
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);

    // A reconnect may have installed a new callback while the old bridge was
    // still opening. In that case this is a stale effect cleanup and must not
    // detach the replacement controller.
    if (this.terminalConnections.get(terminalId) !== connection) return;

    this.terminalConnections.delete(terminalId);
    this.terminalBridges.delete(terminalId);
    this.terminalBridgeLru.delete(terminalId);
    this.client?.closeHerdrBridge(terminalId);
  }

  async closeTerminalBridge(terminalId: string): Promise<void> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);
    this.terminalConnections.delete(terminalId);
    this.terminalOpenings.delete(terminalId);
    this.terminalSizes.delete(terminalId);
    this.terminalBridges.delete(terminalId);
    this.terminalBridgeLru.delete(terminalId);
    this.client?.closeHerdrBridge(terminalId);
  }

  async releaseAllTerminals(): Promise<void> {
    this.terminalConnections.clear();
    this.terminalOpenings.clear();
    this.terminalBridges.clear();
    this.terminalBridgeLru.clear();
    this.client?.closeAllHerdrBridges();
  }

  async snapshot(): Promise<HerdrSnapshot> {
    // A stopped server can be started independently after this SSH connection
    // was opened. Only cache a usable API endpoint so refreshes can discover it.
    const server = this.apiServer?.running ? this.apiServer : await this.probeServer();
    this.apiServer = server.running ? server : null;
    if (!server.running) {
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
    assertHerdrProtocolCompatible(server.protocol, server.compatible !== false);
    if (!server.socket) throw new Error('Herdr server status did not include its API socket');
    let result: SessionSnapshotResult;
    try {
      result = await this.apiRequest<SessionSnapshotResult>('session.snapshot');
    } catch (error) {
      this.apiServer = null;
      throw error;
    }
    if (!result || result.type !== 'session_snapshot' || !result.snapshot) {
      throw new Error('Herdr API socket did not return a session snapshot');
    }
    const snapshot = result.snapshot;
    assertHerdrProtocolCompatible(snapshot.protocol);
    return {
      server: { ...server, version: snapshot.version, protocol: snapshot.protocol, compatible: true },
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

  /**
   * Load the first snapshot on a newly authenticated transport.
   *
   * Some SSH servers briefly reject the first direct-streamlocal channel even
   * though authentication succeeded and the Herdr socket is available. A normal
   * probe must still represent an unavailable socket as an offline server, so
   * confirm that first offline result once on a replacement SSH connection.
   */
  async initialSnapshot(): Promise<HerdrSnapshot> {
    const initial = await this.snapshot();
    if (initial.server.running) return initial;
    await this.reconnectControl();
    return this.snapshot();
  }

  async openEventStream(
    paneIds: string[],
    onEvent: ApiEventHandler,
    onClosed?: TerminalClosedHandler,
  ): Promise<void> {
    this.closeEventStream();
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
      this.closeEventStream();
      onClosed?.(reason);
    };
    const onData = (data: string) => {
      for (const message of decoder.push(data)) {
        const error = apiErrorMessage(message);
        const event = apiEvent(message);
        if (error) {
          close(error);
        } else if (event) {
          onEvent(event);
        } else if ((message as { herdr_android_bridge_closed?: boolean }).herdr_android_bridge_closed) {
          close('Herdr event bridge closed');
        }
      }
    };
    try {
      await client.startHerdrEventStream(server.socket, onData);
      if (generation !== this.eventGeneration) {
        client.closeHerdrEventStream();
        return;
      }
      this.eventClient = client;
      await client.writeHerdrEventStream(apiRequestLine(eventsSubscribeRequest(paneIds)));
    } catch (error) {
      if (this.eventClient === client) this.eventClient = null;
      client.closeHerdrEventStream();
      throw error;
    }
  }

  closeEventStream(): void {
    this.eventGeneration += 1;
    const client = this.eventClient;
    this.eventClient = null;
    client?.closeHerdrEventStream();
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

  async startAgent(name: string, command: string, cwd: string): Promise<void> {
    const created = await this.apiRequest<{
      type: 'workspace_created';
      root_pane: { pane_id: string };
    }>('workspace.create', {
      label: name.trim() || null,
      cwd: cwd.trim() || null,
      focus: true,
    });
    if (name.trim()) {
      await this.apiRequest('pane.rename', { pane_id: created.root_pane.pane_id, label: name.trim() });
    }
    await this.apiRequest('pane.send_input', {
      pane_id: created.root_pane.pane_id,
      text: command.trim(),
      keys: ['Enter'],
    });
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
    await this.apiRequest('workspace.rename', { workspace_id: workspaceId, label });
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
    await this.apiRequest('pane.rename', { pane_id: paneId, label: label.trim() || null });
  }

  async splitPane(paneId: string, direction: 'right' | 'down'): Promise<void> {
    await this.apiRequest('pane.split', { target_pane_id: paneId, direction, focus: true });
  }

  async zoomPane(paneId: string): Promise<void> {
    await this.apiRequest('pane.zoom', { pane_id: paneId, mode: 'toggle' });
  }

  async closePane(paneId: string): Promise<void> {
    await this.apiRequest('pane.close', { pane_id: paneId });
  }

  async runInPane(paneId: string, text: string): Promise<void> {
    await this.apiRequest('pane.send_input', { pane_id: paneId, text, keys: ['Enter'] });
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

  private async apiRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const request: HerdrApiRequest = {
      id: `android_${++this.apiSequence}`,
      method,
      params,
    };
    const response = await this.requireClient().requestHerdrApi(
      await this.apiSocketPath(),
      apiRequestLine(request),
    );
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
    const remoteHome = await this.remoteHomeDirectory();
    const dataDir = profile.sessionName.trim()
      ? `${remoteHome}/.config/herdr/sessions/${profile.sessionName.trim()}`
      : `${remoteHome}/.config/herdr`;
    return `${dataDir}/herdr.sock`;
  }

  private async remoteHomeDirectory(): Promise<string> {
    if (!this.remoteHome) this.remoteHome = await this.requireClient().getRemoteHome();
    return this.remoteHome;
  }

  private async clientSocketPath(): Promise<string> {
    const apiSocket = await this.apiSocketPath();
    return apiSocket.endsWith('.sock')
      ? `${apiSocket.slice(0, -5)}-client.sock`
      : `${apiSocket}-client`;
  }

  private async probeServer(): Promise<ServerInfo> {
    const socket = await this.apiSocketPath();
    try {
      const pong = await this.apiRequest<{
        type: 'pong';
        version: string;
        protocol: number;
      }>('ping');
      return {
        running: true,
        version: pong.version,
        protocol: pong.protocol,
        compatible: true,
        socket,
      };
    } catch (error) {
      if (!isUnavailableSshChannel(error)) throw error;
      return { running: false, socket };
    }
  }

  private baseCommand(): string {
    const profile = this.profile;
    if (!profile) {
      throw new Error('Not connected');
    }
    const command = shellQuote(profile.herdrCommand.trim() || 'herdr');
    return profile.sessionName.trim()
      ? `${command} --session ${shellQuote(profile.sessionName.trim())}`
      : command;
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

  private async connectSsh(profile: ConnectionProfile, port = Number(profile.port)): Promise<SSHClient> {
    const privateKey = normalizePrivateKey(profile.secret);
    return profile.authMode === 'password'
      ? SSHClient.connectWithPassword(profile.host.trim(), port, profile.username.trim(), profile.secret)
      : SSHClient.connectWithKey(
          profile.host.trim(),
          port,
          profile.username.trim(),
          privateKey,
          profile.passphrase || undefined,
        );
  }

  private async attachTerminal(terminalId: string): Promise<void> {
    const size = this.terminalSizes.get(terminalId) || {
      columns: 80,
      rows: 24,
      cellWidthPx: 0,
      cellHeightPx: 0,
    };
    await this.ensureTerminalBridge(terminalId, size);
    await this.requireClient().herdrBridgeResize(
      terminalId,
      size.columns,
      size.rows,
      size.cellWidthPx,
      size.cellHeightPx,
    );
  }

  private async ensureTerminalBridge(terminalId: string, requestedSize?: TerminalSize): Promise<void> {
    if (this.terminalBridges.has(terminalId)) {
      this.touchTerminalBridge(terminalId);
      return;
    }
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) return opening;
    const size = requestedSize || this.terminalSizes.get(terminalId) || {
      columns: 80,
      rows: 24,
      cellWidthPx: 0,
      cellHeightPx: 0,
    };
    const server = await this.requireBridgeServer();
    this.evictLeastRecentlyUsedTerminal(terminalId);
    await this.requireClient().startHerdrBridge(
      await this.clientSocketPath(),
      server.protocol,
      terminalId,
      true,
      size.columns,
      size.rows,
      size.cellWidthPx,
      size.cellHeightPx,
      event => this.handleHerdrBridgeEvent(terminalId, event),
    );
    this.terminalBridges.add(terminalId);
    this.touchTerminalBridge(terminalId);
  }

  private touchTerminalBridge(terminalId: string): void {
    if (!this.terminalBridges.has(terminalId)) return;
    this.terminalBridgeLru.delete(terminalId);
    this.terminalBridgeLru.set(terminalId, true);
  }

  private evictLeastRecentlyUsedTerminal(incomingTerminalId: string): void {
    if (this.terminalBridges.has(incomingTerminalId)) return;
    while (this.terminalBridges.size >= MAX_RETAINED_TERMINAL_BRIDGES) {
      const oldestTerminalId = this.terminalBridgeLru.keys().next().value as string | undefined;
      if (!oldestTerminalId) return;
      this.terminalBridgeLru.delete(oldestTerminalId);
      this.terminalBridges.delete(oldestTerminalId);
      this.client?.closeHerdrBridge(oldestTerminalId);
    }
  }

  private async requireBridgeServer(): Promise<ServerInfo & { protocol: number }> {
    const server = this.apiServer || await this.probeServer();
    this.apiServer = server;
    if (!server.running || typeof server.protocol !== 'number') {
      throw new Error('Herdr server protocol is unavailable');
    }
    assertHerdrProtocolCompatible(server.protocol, server.compatible !== false);
    return server as ServerInfo & { protocol: number };
  }

  private handleHerdrBridgeEvent(terminalId: string, event: HerdrBridgeEvent): void {
    if (event.type === 'terminal') {
      if (
        typeof event.seq === 'number'
        && typeof event.width === 'number'
        && typeof event.height === 'number'
        && typeof event.bytes === 'string'
      ) {
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
    if (event.type === 'closed') {
      this.terminalBridges.delete(terminalId);
      this.terminalBridgeLru.delete(terminalId);
      this.terminalConnections.get(terminalId)?.onClosed?.(
        event.text || 'Herdr remote-client-bridge closed',
      );
    }
  }
}
