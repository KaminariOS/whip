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
    let eventState = null;
    let generation = 0;
    let protocol;
    let resolvedSocket;
    let socketFromCache = Boolean(config.cachedSocketPath && !config.socketPath);
    const bridges = new Map();

    const socketPath = async () => {
      if (config.socketPath) return config.socketPath;
      if (resolvedSocket) return resolvedSocket;
      const home = await runtime.transportClient?.getRemoteHome?.() || `/home/${config.ssh.username}`;
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
        runtime.transportClient = opened[opened.length - 1];
        resolvedSocket = config.socketPath || config.cachedSocketPath;
        generation += 1;
        lifecycleHandler?.({
          type: 'connection-state', state: 'connected', generation,
          reconnectAttempt: 0,
        });
      } catch (error) {
        for (const client of opened.reverse()) client.disconnect?.();
        throw error;
      }
    };

    const startEvents = async state => {
      const token = generation;
      const client = runtime.transportClient;
      await client.startHerdrEventStream?.(
        await socketPath(), protocol || 20, state.paneIds,
        event => {
          if (token !== generation || eventState !== state) return;
          state.handler(event);
        },
      );
    };

    const runtime = {
      runtimeId: config.runtimeId,
      transportKey: `mock-runtime-${config.runtimeId}`,
      transportClient: undefined,
      async connect() { await connectChain(); },
      async disconnect() {
        eventState = null;
        bridges.clear();
        for (const client of clients.reverse()) client.disconnect?.();
        clients = [];
        runtime.transportClient = undefined;
      },
      async recover(_immediate, reason) {
        lifecycleHandler?.({
          type: 'connection-state', state: 'reconnecting', generation,
          reconnectAttempt: 1, error: reason,
        });
        const oldClients = clients;
        runtime.transportClient?.closeHerdrEventStream?.();
        await connectChain();
        for (const client of oldClients.reverse()) client.disconnect?.();
        if (eventState) await startEvents(eventState);
        for (const [terminalId, bridge] of bridges) {
          await runtime.transportClient.startHerdrBridge(
            await socketPath(), protocol || 20, terminalId, bridge.takeover,
            bridge.columns, bridge.rows, bridge.cellWidthPx, bridge.cellHeightPx,
            bridge.handler, (protocol || 20) >= 20 ? 2 : 1,
          );
        }
        lifecycleHandler?.({ type: 'reconnected', generation, restoredTerminals: bridges.size });
      },
      status() { return { state: clients.length ? 'connected' : 'disconnected', generation }; },
      resolvedSocketPath() { return resolvedSocket; },
      resolveHerdrSocketPath() { return socketPath(); },
      async requestHerdrApi(request) {
        const call = async () => {
          const result = await runtime.transportClient.requestHerdrApi(await socketPath(), request);
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
      async startHerdrEventStream(paneIds, handler) {
        const state = { paneIds, handler };
        eventState = state;
        await startEvents(state);
      },
      closeHerdrEventStream() {
        eventState = null;
        runtime.transportClient?.closeHerdrEventStream?.();
      },
      async startHerdrBridge(terminalId, takeover, columns, rows, cellWidthPx, cellHeightPx, launchMode, handler) {
        const bridge = { takeover, columns, rows, cellWidthPx, cellHeightPx, launchMode, handler, state: 'opening' };
        bridges.set(terminalId, bridge);
        if (!protocol) {
          const result = await runtime.transportClient.requestHerdrApi(
            await socketPath(), { method: 'ping', params: {} },
          );
          protocol = result.protocol;
        }
        await runtime.transportClient.startHerdrBridge(
          await socketPath(), protocol || 20, terminalId, takeover, columns, rows,
          cellWidthPx, cellHeightPx, handler, (protocol || 20) >= 20 ? 2 : 1,
        );
        bridge.state = 'attached';
      },
      herdrBridgeInput(terminalId, text) {
        return runtime.transportClient.herdrBridgeInput(terminalId, text);
      },
      herdrBridgeResize(terminalId, columns, rows, cellWidthPx, cellHeightPx) {
        const bridge = bridges.get(terminalId);
        if (bridge) Object.assign(bridge, { columns, rows, cellWidthPx, cellHeightPx });
        return runtime.transportClient.herdrBridgeResize(terminalId, columns, rows, cellWidthPx, cellHeightPx);
      },
      herdrBridgeScroll(terminalId, up, lines, column, row, modifiers = 0) {
        const args = [terminalId, up ? 'up' : 'down', lines, column, row];
        if (modifiers) args.push(modifiers);
        return runtime.transportClient.herdrBridgeScroll(...args);
      },
      closeHerdrBridge(terminalId) {
        bridges.delete(terminalId);
        runtime.transportClient?.closeHerdrBridge?.(terminalId);
      },
      closeAllHerdrBridges() {
        bridges.clear();
        runtime.transportClient?.closeAllHerdrBridges?.();
      },
      hasHerdrBridge(terminalId) { return bridges.get(terminalId)?.state === 'attached'; },
      isHerdrBridgeOpening(terminalId) { return bridges.get(terminalId)?.state === 'opening'; },
    };
    return runtime;
  });

  return { __esModule: true, default: api };
}

module.exports = { createMockWhipSshModule };
