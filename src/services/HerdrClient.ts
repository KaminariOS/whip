import SSHClient, { PtyType } from '@dylankenneally/react-native-ssh-sftp';

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
  TerminalBridgeDecoder,
  terminalInputCommand,
  terminalReleaseCommand,
  terminalResizeCommand,
  terminalScrollCommand,
  type TerminalFrame,
} from '../lib/terminalBridge';
import type { ConnectionProfile, HerdrSnapshot, ServerInfo } from '../types';

type TerminalFrameHandler = (frame: TerminalFrame) => void;
type TerminalClosedHandler = (reason?: string) => void;
type ApiEventHandler = (message: HerdrApiMessage) => void;

interface TerminalConnection {
  client: SSHClient;
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

  /**
   * Replace only the command/control SSH connection. Terminal sessions use
   * dedicated SSH clients and remain alive while the control channel recovers.
   */
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
    previousClient?.off('Shell');
    previousClient?.disconnect();
  }

  disconnect(): void {
    for (const terminalId of this.terminalConnections.keys()) {
      this.closeTerminal(terminalId);
    }
    this.closeEventStream();
    this.client?.off('Shell');
    this.client?.disconnect();
    this.client = null;
    this.profile = null;
    this.apiServer = null;
    this.terminalOpenings.clear();
    this.terminalSizes.clear();
  }

  async openTerminal(
    terminalId: string,
    onFrame: TerminalFrameHandler,
    onClosed?: TerminalClosedHandler,
  ): Promise<void> {
    if (this.terminalConnections.has(terminalId)) {
      return;
    }

    const opening = this.terminalOpenings.get(terminalId);
    if (opening) {
      return opening;
    }

    const task = this.createTerminal(terminalId, onFrame, onClosed);
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
    return this.requireTerminal(terminalId).writeToShell(terminalInputCommand(data));
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
    const connection = this.terminalConnections.get(terminalId);
    if (connection) {
      connection.client.resizeShell(size.columns, size.rows);
      connection.client.writeToShell(
        terminalResizeCommand(size.columns, size.rows, size.cellWidthPx, size.cellHeightPx),
      ).catch(() => {});
    }
  }

  async scrollTerminal(terminalId: string, direction: 'up' | 'down', lines: number): Promise<string> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening;
    return this.requireTerminal(terminalId).writeToShell(
      terminalScrollCommand(direction, Math.max(1, Math.round(lines))),
    );
  }

  closeTerminal(terminalId: string): void {
    const connection = this.terminalConnections.get(terminalId);
    if (!connection) {
      return;
    }
    connection.client.off('Shell');
    connection.client.disconnect();
    this.terminalConnections.delete(terminalId);
  }

  async releaseTerminal(terminalId: string): Promise<void> {
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);
    const connection = this.terminalConnections.get(terminalId);
    if (!connection) return;
    try {
      await connection.client.writeToShell(terminalReleaseCommand());
    } finally {
      this.closeTerminal(terminalId);
    }
  }

  async releaseAllTerminals(): Promise<void> {
    await Promise.all([...new Set([
      ...this.terminalConnections.keys(),
      ...this.terminalOpenings.keys(),
    ])].map(terminalId => this.releaseTerminal(terminalId)));
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
      output = await this.executeFresh(
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
    const profile = this.requireProfile();
    const server = this.apiServer || await this.executeJson<ServerInfo>('status server --json');
    this.apiServer = server;
    if (!server.running || !server.socket) throw new Error('Herdr API socket is not available');
    const generation = ++this.eventGeneration;
    const client = await this.connectSsh(profile);
    if (generation !== this.eventGeneration) {
      client.disconnect();
      return;
    }
    const decoder = new HerdrApiBridgeDecoder();
    const close = (reason?: string) => {
      if (generation !== this.eventGeneration) return;
      this.closeEventStream();
      onClosed?.(reason);
    };
    client.on('Shell', data => {
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
    });
    try {
      await client.startLineShell(PtyType.XTERM);
      if (generation !== this.eventGeneration) {
        client.off('Shell');
        client.disconnect();
        return;
      }
      this.eventClient = client;
      await client.writeToShell(
        `stty -echo; nc -U ${shellQuote(server.socket)}; printf '%s\\n' '{"herdr_android_bridge_closed":true}'\n`,
      );
      await client.writeToShell(apiRequestLine(eventsSubscribeRequest(paneIds)));
    } catch (error) {
      if (this.eventClient === client) this.eventClient = null;
      client.off('Shell');
      client.disconnect();
      throw error;
    }
  }

  closeEventStream(): void {
    this.eventGeneration += 1;
    const client = this.eventClient;
    this.eventClient = null;
    client?.off('Shell');
    client?.disconnect();
  }

  async startServer(): Promise<void> {
    await this.requireClient().execute(
      `nohup ${this.baseCommand()} server >/tmp/herdr-remote-server.log 2>&1 </dev/null &`,
    );
    this.apiServer = null;
  }

  readAgent(target: string): Promise<{ text: string }> {
    return this.executeJson(
      `agent read ${shellQuote(target)} --source recent --lines 160 --format ansi`,
      'read',
    );
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

  private async executeFresh(command: string): Promise<string> {
    const client = await this.connectSsh(this.requireProfile());
    try {
      return await client.execute(command);
    } finally {
      client.disconnect();
    }
  }

  private async createTerminal(
    terminalId: string,
    onFrame: TerminalFrameHandler,
    onClosed?: TerminalClosedHandler,
  ): Promise<void> {
    const profile = this.profile;
    if (!profile) {
      throw new Error('SSH connection is not active');
    }

    const client = await this.connectSsh(profile);
    const decoder = new TerminalBridgeDecoder();
    const onData = (data: string) => {
      const events = decoder.push(data);
      for (const event of events) {
        if (event.type === 'terminal.frame') {
          onFrame(event);
        } else {
          client.off('Shell');
          client.disconnect();
          this.terminalConnections.delete(terminalId);
          onClosed?.(event.reason);
        }
      }
    };
    try {
      client.on('Shell', onData);
      // Herdr's first full redraw is a large newline-delimited JSON record.
      // Keep that record atomic across the native event bridge; losing any one
      // chunk leaves xterm with only later incremental updates.
      await client.startLineShell(PtyType.XTERM);
      this.terminalConnections.set(terminalId, { client });
      const size = this.terminalSizes.get(terminalId) || {
        columns: 80,
        rows: 24,
        cellWidthPx: 0,
        cellHeightPx: 0,
      };
      client.resizeShell(size.columns, size.rows);
      await client.writeToShell(
        `stty -echo; exec ${this.baseCommand()} terminal session control ${shellQuote(terminalId)} --takeover --cols ${size.columns} --rows ${size.rows}\n`,
      );
      // The controller's initial full frame can be emitted while the shell is
      // still handing the channel over to `exec`. Give it one turn to begin
      // reading stdin, then request a deterministic second full redraw.
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
      if (this.terminalConnections.get(terminalId)?.client !== client) return;
      client.resizeShell(size.columns, size.rows);
      await client.writeToShell(
        terminalResizeCommand(size.columns, size.rows, size.cellWidthPx, size.cellHeightPx),
      );
    } catch (error) {
      client.off('Shell');
      client.disconnect();
      this.terminalConnections.delete(terminalId);
      throw error;
    }
  }

  private requireTerminal(terminalId: string): SSHClient {
    const connection = this.terminalConnections.get(terminalId);
    if (!connection) {
      throw new Error(`Terminal ${terminalId} is not connected`);
    }
    return connection.client;
  }
}
