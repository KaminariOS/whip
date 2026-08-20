import {
  call,
  callAsync,
  clearEventSink,
  herdrBridgeInputFast,
  herdrBridgeResizeFast,
  herdrBridgeScrollFast,
  resizeShellFast,
  setEventSink,
  shutdown as shutdownRust,
  type WhipSshEventSink,
  writeShellInput,
} from './generated-entry';

export * from './generated-entry';

type Params = Record<string, unknown>;
type Callback = (error?: string | null, value?: unknown) => void;
type Listener = (event: Record<string, unknown>) => void;

type RustResponse = {
  ok: boolean;
  value?: unknown;
  error?: string;
};

const listeners = new Map<string, Set<Listener>>();

function dispatchEvent(name: string, event: Record<string, unknown>): void {
  for (const listener of listeners.get(name) || []) listener(event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeResponse(responseJson: string): unknown {
  let response: RustResponse;
  try {
    response = JSON.parse(responseJson) as RustResponse;
  } catch {
    throw new Error('Rust SSH returned invalid JSON');
  }
  if (!response.ok) {
    throw new Error(response.error || 'Rust SSH operation failed');
  }
  return response.value;
}

function request(operation: string, params: Params = {}): string {
  return JSON.stringify({ operation, params });
}

function invokeSync(operation: string, params: Params = {}): unknown {
  return decodeResponse(call(request(operation, params)));
}

async function invokeAsync(operation: string, params: Params = {}): Promise<unknown> {
  try {
    return decodeResponse(await callAsync(request(operation, params)));
  } catch (error) {
    console.error(`[WhipSsh] ${operation} failed: ${errorMessage(error)}`);
    throw error;
  }
}

function finish(promise: Promise<unknown>, callback: Callback, select?: (value: any) => unknown): void {
  promise.then(value => {
    const selected = select ? select(value) : value;
    if (selected === undefined || selected === null) callback();
    else callback(null, selected);
  }).catch(error => callback(errorMessage(error)));
}

function finishSync(operation: string, params: Params, callback: Callback): void {
  try {
    const value = invokeSync(operation, params);
    if (value === undefined || value === null) callback();
    else callback(null, value);
  } catch (error) {
    callback(errorMessage(error));
  }
}

function fireSync(operation: string, params: Params): void {
  try {
    invokeSync(operation, params);
  } catch {
    // Matches the legacy void native methods, which cannot report failures.
  }
}

function fireAsync(operation: string, params: Params): void {
  invokeAsync(operation, params).catch(() => {
    // Matches the legacy disconnect methods, which intentionally ignore errors.
  });
}

function credential(passwordOrKey: string | { privateKey?: string; passphrase?: string | null }): Params {
  return typeof passwordOrKey === 'string'
    ? { type: 'password', password: passwordOrKey }
    : {
        type: 'key',
        privateKey: passwordOrKey.privateKey || '',
        passphrase: passwordOrKey.passphrase ?? null,
      };
}

const eventSink: WhipSshEventSink = {
  emit(eventJson: string): void {
    try {
      const event = JSON.parse(eventJson) as Record<string, unknown>;
      const name = typeof event.name === 'string' ? event.name : 'Shell';
      dispatchEvent(name, event);
    } catch {
      // Ignore malformed or application-handler events at the FFI boundary.
    }
  },
  terminalFrame(
    key: string,
    terminalId: string,
    sequence: bigint,
    width: number,
    height: number,
    full: boolean,
    bytes: ArrayBuffer,
  ): void {
    dispatchEvent('HerdrBridge', {
      name: 'HerdrBridge',
      key,
      value: {
        type: 'terminal',
        terminalId,
        seq: Number(sequence),
        width,
        height,
        full,
        bytes,
      },
    });
  },
};

function finishFast(invoke: () => string | undefined, callback: Callback): void {
  try {
    const error = invoke();
    callback(error || undefined);
  } catch (error) {
    callback(errorMessage(error));
  }
}

setEventSink(eventSink);

const nativeClient = {
  addListener(name: string, listener: Listener) {
    let eventListeners = listeners.get(name);
    if (!eventListeners) {
      eventListeners = new Set();
      listeners.set(name, eventListeners);
    }
    eventListeners.add(listener);
    let active = true;
    return {
      remove() {
        if (!active) return;
        active = false;
        eventListeners?.delete(listener);
        if (eventListeners?.size === 0) listeners.delete(name);
      },
    };
  },

  removeListeners(_count: number) {},

  setKnownHosts(contents: string) {
    fireSync('setKnownHosts', { contents: contents || '' });
  },

  getKeyDetails(privateKey: string, passphrase: string | null) {
    return invokeAsync('getKeyDetails', { privateKey: privateKey || '', passphrase });
  },

  generateKeyPair(type: string, passphrase: string, keySize: number, comment: string, callback: Callback) {
    finish(invokeAsync('generateKeyPair', { type: type || 'ed25519', passphrase: passphrase || '', keySize, comment: comment || 'whip' }), callback);
  },

  connectToHost(host: string, port: number, username: string, passwordOrKey: string | Params, key: string, callback: Callback) {
    finish(invokeAsync('connect', { host, port, username, credential: credential(passwordOrKey as any), key }), callback);
  },

  connectToHostByPasswordViaJump(host: string, port: number, username: string, password: string, jumpKey: string, key: string, callback: Callback) {
    finish(invokeAsync('connect', { host, port, username, credential: credential(password), jumpKey, key }), callback);
  },

  connectToHostByKeyViaJump(host: string, port: number, username: string, keyData: Params, jumpKey: string, key: string, callback: Callback) {
    finish(invokeAsync('connect', { host, port, username, credential: credential(keyData as any), jumpKey, key }), callback);
  },

  setAgentForwarding(key: string, enabled: boolean) {
    fireSync('setAgentForwarding', { key, enabled });
  },

  execute(command: string, key: string, callback: Callback) {
    finish(invokeAsync('execute', { command, key }), callback, value => value?.stdout || '');
  },

  startShell(key: string, ptyType: string, callback: Callback) {
    finish(invokeAsync('startShell', { key, ptyType: ptyType || 'xterm-256color' }), callback);
  },

  writeToShell(data: string, key: string, callback: Callback) {
    finishFast(() => writeShellInput(key, data), callback);
  },

  resizeShell(columns: number, rows: number, key: string) {
    try {
      resizeShellFast(key, columns, rows);
    } catch {
      // Matches the legacy void native method, which cannot report failures.
    }
  },

  closeShell(key: string) {
    fireSync('closeShell', { key });
  },

  measureHostLatency(key: string, callback: Callback) {
    finish(invokeAsync('measureHostLatency', { key }), callback);
  },

  getRemoteHome(key: string, callback: Callback) {
    finish(invokeAsync('getRemoteHome', { key }), callback);
  },

  disconnect(key: string) {
    fireAsync('disconnect', { key });
  },

  connectSFTP(key: string, callback: Callback) {
    finish(invokeAsync('connectSFTP', { key }), callback);
  },

  sftpLs(path: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpLs', { path, key }), callback);
  },

  sftpMkdir(path: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpMkdir', { path, key }), callback);
  },

  sftpRm(path: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpRm', { path, key }), callback);
  },

  sftpRmdir(path: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpRmdir', { path, key }), callback);
  },

  sftpRename(oldPath: string, newPath: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpRename', { oldPath, newPath, key }), callback);
  },

  sftpChmod(path: string, permissions: number, key: string, callback: Callback) {
    finish(invokeAsync('sftpChmod', { path, permissions, key }), callback);
  },

  sftpUpload(localPath: string, remotePath: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpUpload', { localPath, remotePath, key }), callback);
  },

  sftpDownload(remotePath: string, localPath: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpDownload', { localPath, remotePath, key }), callback);
  },

  sftpCancelUpload(key: string) {
    fireSync('sftpCancelUpload', { key });
  },

  sftpCancelDownload(key: string) {
    fireSync('sftpCancelDownload', { key });
  },

  disconnectSFTP(key: string) {
    fireAsync('disconnectSFTP', { key });
  },

  prepareHerdrBridge(command: string, protocol: number, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number, key: string, callback: Callback) {
    finish(invokeAsync('prepareHerdrBridge', { command, protocol, columns, rows, cellWidthPx, cellHeightPx, key }), callback);
  },

  startHerdrBridge(socketPath: string, protocol: number, terminalId: string, takeover: boolean, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number, key: string, callback: Callback) {
    finish(invokeAsync('startHerdrBridge', { socketPath, protocol, terminalId, takeover, columns, rows, cellWidthPx, cellHeightPx, key }), callback);
  },

  herdrBridgeInput(terminalId: string, text: string, key: string, callback: Callback) {
    finishFast(() => herdrBridgeInputFast(key, terminalId, text), callback);
  },

  herdrBridgeResize(columns: number, rows: number, cellWidthPx: number, cellHeightPx: number, terminalId: string, key: string, callback: Callback) {
    finishFast(
      () => herdrBridgeResizeFast(
        key,
        terminalId,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      ),
      callback,
    );
  },

  herdrBridgeScroll(up: boolean, lines: number, terminalId: string, key: string, callback: Callback) {
    finishFast(() => herdrBridgeScrollFast(key, terminalId, up, lines), callback);
  },

  closeHerdrBridge(terminalId: string, key: string) {
    fireSync('closeHerdrBridge', { terminalId, key });
  },

  closeAllHerdrBridges(key: string) {
    fireSync('closeAllHerdrBridges', { key });
  },

  openLocalForward(remoteHost: string, remotePort: number, key: string, callback: Callback) {
    finish(invokeAsync('openLocalForward', { remoteHost, remotePort, key }), callback);
  },

  closeLocalForward(localPort: number, key: string, callback: Callback) {
    finishSync('closeLocalForward', { localPort, key }, callback);
  },

  requestHerdrApi(socketPath: string, requestJson: string, key: string, callback: Callback) {
    finish(invokeAsync('requestHerdrApi', { socketPath, request: requestJson, key }), callback);
  },

  startHerdrEventStream(socketPath: string, key: string, callback: Callback) {
    finish(invokeAsync('startHerdrEventStream', { socketPath, key }), callback);
  },

  writeHerdrEventStream(value: string, key: string, callback: Callback) {
    finishSync('writeHerdrEventStream', { value, key }, callback);
  },

  closeHerdrEventStream(key: string) {
    fireSync('closeHerdrEventStream', { key });
  },

  startHerdrCommandStream(command: string, key: string, callback: Callback) {
    finish(invokeAsync('startHerdrCommandStream', { command, key }), callback);
  },

  writeHerdrCommandStream(value: string, key: string, callback: Callback) {
    finishSync('writeHerdrCommandStream', { value, key }, callback);
  },

  closeHerdrCommandStream(key: string) {
    fireSync('closeHerdrCommandStream', { key });
  },
};

declare const module: { hot?: { dispose(callback: () => void): void } };
if (typeof module !== 'undefined' && module.hot) {
  module.hot.dispose(() => {
    listeners.clear();
    clearEventSink();
    shutdownRust();
  });
}

export default nativeClient;
