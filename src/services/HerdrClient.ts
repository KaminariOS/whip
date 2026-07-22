import SSHClient, {
  type HerdrBridgeEvent,
  type HerdrCommandStreamEvent,
} from '@dylankenneally/react-native-ssh-sftp';

import { normalizePrivateKey } from '../lib/privateKey';
import { assertHerdrProtocolCompatible } from '../lib/herdrProtocol';
import {
  apiEvent,
  apiErrorMessage,
  apiRequestLine,
  eventsSubscribeRequest,
  HerdrApiBridgeDecoder,
  sessionSnapshotRequest,
  type HerdrApiEvent,
  type SessionSnapshotResult,
} from '../lib/herdrApiBridge';
import { parseJsonResponse, shellQuote } from '../lib/shell';
import {
  type TerminalFrame,
} from '../lib/terminalBridge';
import type { ConnectionProfile, HerdrSnapshot, ServerInfo } from '../types';

type TerminalFrameHandler = (frame: TerminalFrame) => void;
type TerminalClosedHandler = (reason?: string) => void;
type ApiEventHandler = (event: HerdrApiEvent) => void;

// Seed common Homebrew/Linux prefixes onto PATH for the command shell. A
// non-login SSH shell on macOS omits /opt/homebrew/bin (Homebrew adds it only
// in ~/.zprofile, sourced by login shells), so bare `herdr` isn't found. The
// prefixes are harmless where they don't exist (e.g. Linux) and $PATH is kept.
//
// The command runs through an SSH exec channel, which the remote *login* shell
// interprets. A bare `VAR=value command` prefix is POSIX-only (csh/tcsh reject
// it), so wrap the assignment inside `/bin/sh -c` — a plain command every login
// shell can launch — and let that sh do the PATH expansion, then exec the shell.
// See https://github.com/KaminariOS/whip/issues/15
const COMMAND_STREAM_SHELL =
  '/bin/sh -c \'PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$PATH" exec /bin/sh\'';

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

interface PendingCommand {
  marker: string;
  resolve: (output: string) => void;
  reject: (error: unknown) => void;
}

export class HerdrClient {
  private client: SSHClient | null = null;
  private profile: ConnectionProfile | null = null;
  private terminalConnections = new Map<string, TerminalConnection>();
  private terminalOpenings = new Map<string, Promise<void>>();
  private terminalSizes = new Map<string, TerminalSize>();
  private terminalBridges = new Set<string>();
  private eventClient: SSHClient | null = null;
  private eventGeneration = 0;
  private apiServer: ServerInfo | null = null;
  private controlConnect: Promise<void> | null = null;
  private controlReconnect: Promise<void> | null = null;
  private commandStreamOpening: Promise<void> | null = null;
  private commandStreamReady = false;
  private commandGeneration = 0;
  private commandSequence = 0;
  private commandBuffer = '';
  private pendingCommand: PendingCommand | null = null;
  private commandQueue: Promise<void> = Promise.resolve();

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
    this.resetCommandStream('SSH control connection was replaced');
    this.client = nextClient;
    this.profile = profile;
    this.apiServer = null;
    this.eventClient = null;
    this.terminalBridges.clear();
    this.terminalOpenings.clear();
    previousClient?.off('Shell');
    previousClient?.closeHerdrCommandStream();
    previousClient?.disconnect();

    // A control reconnect is transport maintenance, not a terminal failure.
    // Restore the visible terminal on the replacement session while preserving
    // its frame and close callbacks, then let inactive tabs attach on demand.
    const terminalIds = [...this.terminalConnections.keys()];
    await Promise.all(terminalIds.map(async terminalId => {
      try {
        await this.attachTerminal(terminalId);
      } catch (error) {
        this.terminalConnections.get(terminalId)?.onClosed?.(
          `Terminal reattach failed: ${String(error)}`,
        );
      }
    }));
  }

  disconnect(): void {
    this.closeEventStream();
    this.resetCommandStream('SSH connection was closed');
    this.client?.closeHerdrCommandStream();
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
    this.controlReconnect = null;
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
    const connection = this.terminalConnections.get(terminalId);
    const opening = this.terminalOpenings.get(terminalId);
    if (opening) await opening.catch(() => undefined);

    // A reconnect may have installed a new callback while the old bridge was
    // still opening. In that case this is a stale effect cleanup and must not
    // detach the replacement controller.
    if (this.terminalConnections.get(terminalId) !== connection) return;

    this.terminalConnections.delete(terminalId);
    this.terminalBridges.delete(terminalId);
    this.client?.closeHerdrBridge(terminalId);
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
    this.terminalOpenings.clear();
    this.terminalBridges.clear();
    this.client?.closeAllHerdrBridges();
  }

  async snapshot(): Promise<HerdrSnapshot> {
    const server = this.apiServer || await this.executeJson<ServerInfo>('status server --json');
    this.apiServer = server;
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
    const request = JSON.stringify(sessionSnapshotRequest());
    let output: string;
    try {
      output = await this.executeCommand(
        // Apple's netcat treats a bare `-N` as an adaptive-write-timeout flag
        // that requires an integer argument, so passing it before `-U <sock>`
        // aborts on macOS. Herdr closes the socket after replying, so the
        // half-close that flag provided was never needed here. Plain `nc -U`
        // is portable across Apple and OpenBSD/GNU netcat.
        // See https://github.com/KaminariOS/whip/issues/15
        `printf '%s\\n' ${shellQuote(request)} | nc -U ${shellQuote(server.socket)} 2>&1`,
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
    await this.executeCommand(
      `nohup ${this.baseCommand()} server >/tmp/whip-herdr-server.log 2>&1 </dev/null &`,
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
    await this.executeFocusJson(`agent focus ${shellQuote(target)}`);
  }

  async startAgent(name: string, command: string, cwd: string): Promise<void> {
    const cwdArg = cwd.trim() ? `--cwd ${shellQuote(cwd.trim())}` : '';
    await this.executeJson(
      `agent start ${shellQuote(name.trim())} ${cwdArg} --focus -- sh -lc ${shellQuote(command.trim())}`,
    );
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.executeFocusJson(`workspace focus ${shellQuote(workspaceId)}`);
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
    await this.executeFocusJson(`tab focus ${shellQuote(tabId)}`);
  }

  async focusPane(paneId: string): Promise<void> {
    await this.executeFocusJson(`pane focus ${shellQuote(paneId)}`);
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
    const output = await this.executeCommand(`${this.baseCommand()} ${args} 2>&1`);
    return parseJsonResponse<T>(output, resultKey);
  }

  private async executeFocusJson<T>(args: string, resultKey?: string): Promise<T> {
    const reconnecting = this.controlReconnect;
    if (reconnecting) await reconnecting;
    try {
      return await this.executeJson<T>(args, resultKey);
    } catch (error) {
      if (!isUnavailableSshChannel(error)) throw error;
      await this.reconnectControl();
      return this.executeJson<T>(args, resultKey);
    }
  }

  private executeText(args: string): Promise<string> {
    return this.executeCommand(`${this.baseCommand()} ${args} 2>&1`);
  }

  private executeCommand(command: string): Promise<string> {
    const task = this.commandQueue.then(() => this.runCommand(command));
    this.commandQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async runCommand(command: string): Promise<string> {
    await this.ensureCommandStream();
    const id = `${this.commandGeneration}_${++this.commandSequence}`;
    const marker = `WHIP_COMMAND_${id}`;
    const result = new Promise<string>((resolve, reject) => {
      this.pendingCommand = { marker, resolve, reject };
    });
    const script = `${command}\n__whip_status=$?\nprintf '\\036${marker}:%s\\037\\n' "$__whip_status"\n`;
    try {
      await this.requireClient().writeHerdrCommandStream(script);
    } catch (error) {
      this.failPendingCommand(error);
    }
    return result;
  }

  private async ensureCommandStream(): Promise<void> {
    if (this.commandStreamReady) return;
    if (this.commandStreamOpening) return this.commandStreamOpening;
    const client = this.requireClient();
    const generation = ++this.commandGeneration;
    const task = client.startHerdrCommandStream(
      COMMAND_STREAM_SHELL,
      event => {
        if (generation === this.commandGeneration) this.handleCommandStreamEvent(event);
      },
    );
    this.commandStreamOpening = task;
    try {
      await task;
      if (generation === this.commandGeneration) this.commandStreamReady = true;
    } finally {
      if (this.commandStreamOpening === task) this.commandStreamOpening = null;
    }
  }

  private handleCommandStreamEvent(event: HerdrCommandStreamEvent): void {
    if (event.data) {
      this.commandBuffer += event.data;
      this.resolveCommandFrame();
    }
    if (event.closed) {
      this.commandStreamReady = false;
      this.failPendingCommand(event.error || 'Herdr command stream closed');
    }
  }

  private resolveCommandFrame(): void {
    const pending = this.pendingCommand;
    if (!pending) return;
    const markerStart = `\u001e${pending.marker}:`;
    const start = this.commandBuffer.indexOf(markerStart);
    if (start < 0) return;
    const end = this.commandBuffer.indexOf('\u001f', start + markerStart.length);
    if (end < 0) return;
    const output = this.commandBuffer.slice(0, start);
    this.commandBuffer = this.commandBuffer.slice(end + 1).replace(/^\r?\n/, '');
    this.pendingCommand = null;
    pending.resolve(output);
  }

  private failPendingCommand(error: unknown): void {
    const pending = this.pendingCommand;
    this.pendingCommand = null;
    this.commandBuffer = '';
    pending?.reject(error);
  }

  private resetCommandStream(reason: string): void {
    this.commandGeneration += 1;
    this.commandStreamReady = false;
    this.commandStreamOpening = null;
    this.failPendingCommand(reason);
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
  }

  private async requireBridgeServer(): Promise<ServerInfo & { protocol: number }> {
    const server = this.apiServer || await this.executeJson<ServerInfo>('status server --json');
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
      this.terminalConnections.get(terminalId)?.onClosed?.(
        event.text || 'Herdr remote-client-bridge closed',
      );
    }
  }
}
