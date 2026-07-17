import SSHClient, {
  type HerdrBridgeEvent,
} from '@dylankenneally/react-native-ssh-sftp';

import { normalizePrivateKey } from '../lib/privateKey';
import {
  apiErrorMessage,
  apiRequestLine,
  eventsSubscribeRequest,
  HerdrApiBridgeDecoder,
  sessionSnapshotRequest,
  type HerdrApiMessage,
  type SessionSnapshotResult,
} from '../lib/herdrApiBridge';
import { parseJsonResponse, shellQuote } from '../lib/shell';
import {
  type TerminalFrame,
} from '../lib/terminalBridge';
import type { ConnectionProfile, HerdrSnapshot, ServerInfo } from '../types';

type TerminalFrameHandler = (frame: TerminalFrame) => void;
type TerminalClosedHandler = (reason?: string) => void;
type ApiEventHandler = (message: HerdrApiMessage) => void;

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

export class HerdrClient {
  private client: SSHClient | null = null;
  private profile: ConnectionProfile | null = null;
  private terminalConnections = new Map<string, TerminalConnection>();
  private terminalOpenings = new Map<string, Promise<void>>();
  private terminalSizes = new Map<string, TerminalSize>();
  private terminalBridges = new Set<string>();
  private bridgePrepareOpening: Promise<void> | null = null;
  private eventClient: SSHClient | null = null;
  private eventGeneration = 0;
  private apiServer: ServerInfo | null = null;

  async connect(profile: ConnectionProfile): Promise<void> {
    const port = Number(profile.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be between 1 and 65535');
    }

    this.client = await this.connectSsh(profile, port);
    this.profile = profile;
    this.apiServer = null;
  }

  /** Replace the single authenticated SSH session and recreate its channels. */
  async reconnectControl(profile: ConnectionProfile = this.requireProfile()): Promise<void> {
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
    this.terminalBridges.clear();
    this.bridgePrepareOpening = null;
    for (const connection of this.terminalConnections.values()) {
      connection.onClosed?.('SSH control connection was replaced');
    }
    previousClient?.off('Shell');
    previousClient?.disconnect();
  }

  disconnect(): void {
    this.closeEventStream();
    this.client?.closeAllHerdrBridges();
    this.client?.off('Shell');
    this.client?.disconnect();
    this.client = null;
    this.profile = null;
    this.apiServer = null;
    this.terminalOpenings.clear();
    this.terminalConnections.clear();
    this.terminalSizes.clear();
    this.terminalBridges.clear();
    this.bridgePrepareOpening = null;
  }

  async openTerminal(
    terminalId: string,
    onFrame: TerminalFrameHandler,
    onClosed?: TerminalClosedHandler,
  ): Promise<void> {
    this.terminalConnections.set(terminalId, { onFrame, onClosed });

    const opening = this.terminalOpenings.get(terminalId);
    if (opening) {
      return opening;
    }

    const task = this.attachTerminal(terminalId);
    this.terminalOpenings.set(terminalId, task);
    try {
      await task;
    } finally {
      this.terminalOpenings.delete(terminalId);
    }
  }

  async prepareTerminalBridge(): Promise<void> {
    if (this.bridgePrepareOpening) return this.bridgePrepareOpening;
    const task = (async () => {
      const server = await this.requireBridgeServer();
      await this.requireClient().prepareHerdrBridge(
        `${this.baseCommand()} remote-client-bridge`,
        server.protocol,
        80,
        24,
        0,
        0,
      );
    })();
    this.bridgePrepareOpening = task;
    try {
      await task;
    } finally {
      if (this.bridgePrepareOpening === task) this.bridgePrepareOpening = null;
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
  }

  async releaseTerminal(terminalId: string): Promise<void> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);
    this.closeTerminal(terminalId);
  }

  async closeTerminalBridge(terminalId: string): Promise<void> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);
    this.terminalConnections.delete(terminalId);
    this.terminalOpenings.delete(terminalId);
    this.terminalSizes.delete(terminalId);
    this.terminalBridges.delete(terminalId);
    this.client?.closeHerdrBridge(terminalId);
  }

  async releaseAllTerminals(): Promise<void> {
    this.terminalConnections.clear();
  }

  async snapshot(): Promise<HerdrSnapshot> {
    const server = this.apiServer || await this.executeJson<ServerInfo>('status server --json');
    this.apiServer = server;
    if (!server.running) {
      return { server, agents: [], workspaces: [], tabs: [], panes: [] };
    }
    if (!server.socket) throw new Error('Herdr server status did not include its API socket');
    const request = JSON.stringify(sessionSnapshotRequest());
    let output: string;
    try {
      output = await this.requireClient().execute(
        `printf '%s\\n' ${shellQuote(request)} | nc -N -U ${shellQuote(server.socket)} 2>&1`,
      );
    } catch (error) {
      this.apiServer = null;
      throw error;
    }
    const result = parseJsonResponse<SessionSnapshotResult>(output);
    if (!result || result.type !== 'session_snapshot' || !result.snapshot) {
      throw new Error('Herdr API socket did not return a session snapshot');
    }
    const snapshot = result.snapshot;
    return {
      server: { ...server, version: snapshot.version, protocol: snapshot.protocol, compatible: true },
      agents: snapshot.agents,
      workspaces: snapshot.workspaces,
      tabs: snapshot.tabs,
      panes: snapshot.panes,
    };
  }

  async openEventStream(
    paneIds: string[],
    onEvent: ApiEventHandler,
    onClosed?: TerminalClosedHandler,
  ): Promise<void> {
    this.closeEventStream();
    const server = this.apiServer || await this.executeJson<ServerInfo>('status server --json');
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
        if (error) {
          close(error);
        } else if ('subscription_id' in message && message.event) {
          onEvent(message);
        } else if ((message as { herdr_android_bridge_closed?: boolean }).herdr_android_bridge_closed) {
          close('Herdr event bridge closed');
        }
      }
    };
    try {
      await client.startHerdrEventStream(`nc -U ${shellQuote(server.socket)}`, onData);
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
    await this.requireClient().execute(
      `nohup ${this.baseCommand()} server >/tmp/herdr-remote-server.log 2>&1 </dev/null &`,
    );
    this.apiServer = null;
  }

  readPane(paneId: string): Promise<string> {
    return this.executeJson<{ text: string }>(
      `pane read ${shellQuote(paneId)} --source recent --lines 160 --format ansi`,
      'read',
    ).then(read => read.text);
  }

  async sendAgent(target: string, text: string): Promise<void> {
    await this.executeJson(`agent send ${shellQuote(target)} ${shellQuote(`${text}\n`)}`);
  }

  async focusAgent(target: string): Promise<void> {
    await this.executeJson(`agent focus ${shellQuote(target)}`);
  }

  async startAgent(name: string, command: string, cwd: string): Promise<void> {
    const cwdArg = cwd.trim() ? `--cwd ${shellQuote(cwd.trim())}` : '';
    await this.executeJson(
      `agent start ${shellQuote(name.trim())} ${cwdArg} --focus -- sh -lc ${shellQuote(command.trim())}`,
    );
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.executeJson(`workspace focus ${shellQuote(workspaceId)}`);
  }

  async createWorkspace(label: string, cwd: string): Promise<void> {
    const args = [
      'workspace create',
      label.trim() ? `--label ${shellQuote(label.trim())}` : '',
      cwd.trim() ? `--cwd ${shellQuote(cwd.trim())}` : '',
      '--focus',
    ].filter(Boolean).join(' ');
    await this.executeJson(args);
  }

  async renameWorkspace(workspaceId: string, label: string): Promise<void> {
    await this.executeJson(`workspace rename ${shellQuote(workspaceId)} ${shellQuote(label)}`);
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.executeJson(`workspace close ${shellQuote(workspaceId)}`);
  }

  async createTab(workspaceId: string, label: string): Promise<void> {
    await this.executeJson(
      `tab create --workspace ${shellQuote(workspaceId)} ${label.trim() ? `--label ${shellQuote(label.trim())}` : ''} --focus`,
    );
  }

  async focusTab(tabId: string): Promise<void> {
    await this.executeJson(`tab focus ${shellQuote(tabId)}`);
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.executeJson(`tab rename ${shellQuote(tabId)} ${shellQuote(label)}`);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.executeJson(`tab close ${shellQuote(tabId)}`);
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    const value = label.trim() ? shellQuote(label.trim()) : '--clear';
    await this.executeJson(`pane rename ${shellQuote(paneId)} ${value}`);
  }

  async splitPane(paneId: string, direction: 'right' | 'down'): Promise<void> {
    await this.executeJson(`pane split ${shellQuote(paneId)} --direction ${direction} --focus`);
  }

  async zoomPane(paneId: string): Promise<void> {
    await this.executeJson(`pane zoom ${shellQuote(paneId)} --toggle`);
  }

  async closePane(paneId: string): Promise<void> {
    await this.executeJson(`pane close ${shellQuote(paneId)}`);
  }

  async runInPane(paneId: string, text: string): Promise<void> {
    await this.executeJson(`pane run ${shellQuote(paneId)} ${shellQuote(text)}`);
  }

  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    await this.executeJson(`pane send-keys ${shellQuote(paneId)} ${keys.map(shellQuote).join(' ')}`);
  }

  private async executeJson<T>(args: string, resultKey?: string): Promise<T> {
    const output = await this.requireClient().execute(`${this.baseCommand()} ${args} 2>&1`);
    return parseJsonResponse<T>(output, resultKey);
  }

  private executeText(args: string): Promise<string> {
    return this.requireClient().execute(`${this.baseCommand()} ${args} 2>&1`);
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
    if (this.terminalBridges.has(terminalId)) return;
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) return opening;
    const size = requestedSize || this.terminalSizes.get(terminalId) || {
      columns: 80,
      rows: 24,
      cellWidthPx: 0,
      cellHeightPx: 0,
    };
    const server = await this.requireBridgeServer();
    await this.requireClient().startHerdrBridge(
      `${this.baseCommand()} remote-client-bridge`,
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
    this.prepareTerminalBridge().catch(() => undefined);
  }

  private async requireBridgeServer(): Promise<ServerInfo & { protocol: number }> {
    const server = this.apiServer || await this.executeJson<ServerInfo>('status server --json');
    this.apiServer = server;
    if (!server.running || typeof server.protocol !== 'number') {
      throw new Error('Herdr server protocol is unavailable');
    }
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
      this.terminalConnections.get(terminalId)?.onClosed?.(
        event.text || 'Herdr remote-client-bridge closed',
      );
    }
  }
}
