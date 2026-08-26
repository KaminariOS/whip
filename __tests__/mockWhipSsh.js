/* global TextDecoder, TextEncoder */

function unavailable(error) {
  const value = String(error?.message || error || '').toLowerCase();
  return value.includes('channel not open')
    || value.includes('channel is not opened')
    || value.includes('failed to open channel')
    || value.includes('session is down')
    || value.includes('socket is not established');
}

function createMockWhipSshModule() {
  const api = {
    connectWithPassword: jest.fn(),
    connectWithPasswordViaJump: jest.fn(),
    connectWithKey: jest.fn(),
    connectWithKeyViaJump: jest.fn(),
    createHostRuntime: jest.fn(),
  };

  const connectOne = async (config, jump) => {
    const args = [config.host, config.port, config.username, config.secret];
    let client;
    if (config.authMode === 'key') {
      client = jump
        ? await api.connectWithKeyViaJump(...args, config.passphrase, jump)
        : await api.connectWithKey(...args, config.passphrase);
    } else {
      client = jump
        ? await api.connectWithPasswordViaJump(...args, jump)
        : await api.connectWithPassword(...args);
    }
    if (config.forwardAgent) await client.setAgentForwarding?.(true);
    return client;
  };

  api.createHostRuntime.mockImplementation((config, lifecycleHandler) => {
    let clients = [];
    let generation = 0;
    let protocol;
    let resolvedSocket;
    let socketFromCache = Boolean(config.cachedSocketPath && !config.socketPath);
    const bridges = new Map();
    const sshShells = new Map();
    let hostState = {
      revision: 0,
      connectionGeneration: 0,
      syncGeneration: 0,
      syncStatus: 'idle',
      freshness: 'loading',
      needsResync: false,
      focus: {},
    };

    const emitHostState = (changedAgentPaneIds = []) => lifecycleHandler?.({
      type: 'host-state', state: hostState, changedAgentPaneIds,
    });

    const socketPath = async () => {
      if (config.socketPath) return config.socketPath;
      if (resolvedSocket) return resolvedSocket;
      const home = await runtime.controlClient?.getRemoteHome?.() || `/home/${config.ssh.username}`;
      const dataDir = config.sessionName
        ? `${home}/.config/herdr/sessions/${config.sessionName}`
        : `${home}/.config/herdr`;
      resolvedSocket = `${dataDir}/herdr.sock`;
      return resolvedSocket;
    };

    const connectChain = async () => {
      const opened = [];
      try {
        let jump;
        for (const entry of [...config.jumpHosts, config.ssh]) {
          jump = await connectOne(entry, jump);
          opened.push(jump);
        }
        clients = opened;
        runtime.controlClient = opened[opened.length - 1];
        resolvedSocket = config.socketPath || config.cachedSocketPath;
        generation += 1;
        hostState = {
          ...hostState,
          revision: hostState.revision + 1,
          connectionGeneration: generation,
          freshness: hostState.snapshot ? 'stale' : 'loading',
          needsResync: true,
        };
        lifecycleHandler?.({
          type: 'connection-state', state: 'connected', generation,
          reconnectAttempt: 0,
        });
      } catch (error) {
        for (const client of opened.reverse()) client.disconnect?.();
        throw error;
      }
    };

    const runtime = {
      runtimeId: config.runtimeId,
      controlClient: undefined,
      async connect() {
        await connectChain();
        await runtime.refreshState();
      },
      async disconnect() {
        bridges.clear();
        sshShells.clear();
        for (const client of clients.reverse()) client.disconnect?.();
        clients = [];
        runtime.controlClient = undefined;
      },
      async recover(_immediate, reason) {
        lifecycleHandler?.({
          type: 'connection-state', state: 'reconnecting', generation,
          reconnectAttempt: 1, error: reason,
        });
        const oldClients = clients;
        await connectChain();
        await runtime.refreshState();
        for (const client of oldClients.reverse()) client.disconnect?.();
        for (const [terminalId, bridge] of bridges) {
          await runtime.controlClient.startHerdrBridge(
            await socketPath(), protocol || 20, terminalId, bridge.takeover,
            bridge.columns, bridge.rows, bridge.cellWidthPx, bridge.cellHeightPx,
            bridge.handler, (protocol || 20) >= 20 ? 2 : 1,
          );
        }
        lifecycleHandler?.({ type: 'reconnected', generation, restoredTerminals: bridges.size });
      },
      status() { return { state: clients.length ? 'connected' : 'disconnected', generation }; },
      hostState() { return hostState; },
      async refreshState() {
        const syncGeneration = hostState.syncGeneration + 1;
        hostState = {
          ...hostState,
          revision: hostState.revision + 1,
          syncGeneration,
          syncStatus: 'syncing',
          freshness: hostState.snapshot ? 'stale' : 'loading',
          error: undefined,
        };
        emitHostState();
        let result;
        let failure;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            result = await runtime.requestHerdrApi({ method: 'session.snapshot', params: {} });
            failure = undefined;
            break;
          } catch (error) {
            failure = error;
            if (!unavailable(error)) break;
          }
        }
        if (result?.type === 'session_snapshot' && result.snapshot) {
          hostState = {
            ...hostState,
            revision: hostState.revision + 1,
            syncStatus: 'synced',
            freshness: 'fresh',
            error: undefined,
            needsResync: false,
            lastSyncedAtMs: Date.now(),
            focus: {
              workspaceId: result.snapshot.focused_workspace_id,
              tabId: result.snapshot.focused_tab_id,
              paneId: result.snapshot.focused_pane_id,
            },
            snapshot: result.snapshot,
          };
        } else {
          hostState = {
            ...hostState,
            revision: hostState.revision + 1,
            syncStatus: 'error',
            freshness: hostState.snapshot ? 'stale' : 'unavailable',
            error: String(failure || 'Herdr host state unavailable'),
            needsResync: true,
          };
        }
        emitHostState();
        return hostState;
      },
      resolvedSocketPath() { return resolvedSocket; },
      resolveHerdrSocketPath() { return socketPath(); },
      async requestHerdrApi(request) {
        const call = async () => {
          const result = await runtime.controlClient.requestHerdrApi(await socketPath(), request);
          if (typeof result?.protocol === 'number') protocol = result.protocol;
          if (typeof result?.snapshot?.protocol === 'number') protocol = result.snapshot.protocol;
          return result;
        };
        try {
          return await call();
        } catch (error) {
          const replayable = ['workspace.focus', 'tab.focus', 'pane.focus', 'agent.focus']
            .includes(request.method);
          const replayableSocketRequest = replayable
            || ['ping', 'session.snapshot', 'pane.read'].includes(request.method);
          if (socketFromCache && unavailable(error) && replayableSocketRequest) {
            socketFromCache = false;
            resolvedSocket = undefined;
            return call();
          }
          if (!replayable || !unavailable(error)) throw error;
          await runtime.recover(true, String(error));
          return call();
        }
      },
      async startHerdrBridge(terminalId, takeover, columns, rows, cellWidthPx, cellHeightPx, launchMode, handler) {
        const bridge = { takeover, columns, rows, cellWidthPx, cellHeightPx, launchMode, handler, state: 'opening' };
        bridges.set(terminalId, bridge);
        if (!protocol) {
          const result = await runtime.controlClient.requestHerdrApi(
            await socketPath(), { method: 'ping', params: {} },
          );
          protocol = result.protocol;
        }
        await runtime.controlClient.startHerdrBridge(
          await socketPath(), protocol || 20, terminalId, takeover, columns, rows,
          cellWidthPx, cellHeightPx, handler, (protocol || 20) >= 20 ? 2 : 1,
        );
        bridge.state = 'attached';
      },
      herdrBridgeInput(terminalId, text) {
        return runtime.controlClient.herdrBridgeInput(terminalId, text);
      },
      herdrBridgeResize(terminalId, columns, rows, cellWidthPx, cellHeightPx) {
        const bridge = bridges.get(terminalId);
        if (bridge) Object.assign(bridge, { columns, rows, cellWidthPx, cellHeightPx });
        return runtime.controlClient.herdrBridgeResize(terminalId, columns, rows, cellWidthPx, cellHeightPx);
      },
      herdrBridgeScroll(terminalId, up, lines, column, row, modifiers = 0) {
        const args = [terminalId, up ? 'up' : 'down', lines, column, row];
        if (modifiers) args.push(modifiers);
        return runtime.controlClient.herdrBridgeScroll(...args);
      },
      closeHerdrBridge(terminalId) {
        bridges.delete(terminalId);
        runtime.controlClient?.closeHerdrBridge?.(terminalId);
      },
      closeAllHerdrBridges() {
        bridges.clear();
        runtime.controlClient?.closeAllHerdrBridges?.();
      },
      hasHerdrBridge(terminalId) { return bridges.get(terminalId)?.state === 'attached'; },
      isHerdrBridgeOpening(terminalId) { return bridges.get(terminalId)?.state === 'opening'; },
      async openSshShell(terminalId, columns, rows, handler) {
        const client = runtime.controlClient;
        const onData = data => {
          const bytes = new TextEncoder().encode(data);
          handler.data(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        };
        sshShells.set(terminalId, { client, handler, onData });
        client.on('Shell', onData);
        await client.startShell('xterm-256color');
        client.resizeShell(columns, rows);
      },
      sshShellInput(terminalId, bytes) {
        const shell = sshShells.get(terminalId);
        if (!shell) throw new Error(`SSH shell ${terminalId} is not connected`);
        return shell.client.writeToShell(new TextDecoder().decode(bytes));
      },
      resizeSshShell(terminalId, columns, rows) {
        const shell = sshShells.get(terminalId);
        if (!shell) throw new Error(`SSH shell ${terminalId} is not connected`);
        shell.client.resizeShell(columns, rows);
      },
      closeSshShell(terminalId) {
        const shell = sshShells.get(terminalId);
        if (!shell) return;
        sshShells.delete(terminalId);
        shell.client.off('Shell');
        shell.client.closeShell();
      },
      hasSshShell(terminalId) { return sshShells.has(terminalId); },
      execute(command) { return runtime.controlClient.execute(command); },
      remoteHome() { return runtime.controlClient.getRemoteHome(); },
      measureHostLatency() { return runtime.controlClient.measureHostLatency(); },
      async openLocalForward(host, port) { return runtime.controlClient.openLocalForward(host, port); },
      closeLocalForward(port) { return runtime.controlClient.closeLocalForward(port); },
      sftpLs(path) { return runtime.controlClient.sftpLs(path); },
      sftpRemove(path, directory) {
        return directory ? runtime.controlClient.sftpRmdir(path) : runtime.controlClient.sftpRm(path);
      },
      sftpCreateDirAll(path) { return runtime.controlClient.sftpCreateDirAll(path); },
      sftpUpload(local, remote, exact = false) {
        return exact
          ? runtime.controlClient.sftpUploadToPath(local, remote)
          : runtime.controlClient.sftpUpload(local, remote);
      },
      sftpDownload(remote, local) { return runtime.controlClient.sftpDownload(remote, local); },
      cancelSftpUpload() { return runtime.controlClient.sftpCancelUpload(); },
      startSftpFileServer(path) { return runtime.controlClient.startSftpFileServer(path); },
      closeSftpFileServer(port) { return runtime.controlClient.closeSftpFileServer(port); },
    };
    return runtime;
  });

  return { __esModule: true, default: api };
}

module.exports = { createMockWhipSshModule };
