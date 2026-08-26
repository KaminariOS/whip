import {
  call,
  callAsync,
  clearEventSink,
  resizeShellFast,
  setEventSink,
  shutdown as shutdownRust,
  type WhipSshEventSink,
  writeUnixSocketChannel as writeUnixSocketChannelRust,
  writeLengthPrefixedUnixSocketChannel as writeLengthPrefixedUnixSocketChannelRust,
  writeExecChannel as writeExecChannelRust,
  writeShellInput,
} from './generated-entry';

export * from './generated-entry';

type Params = Record<string, unknown>;
type Callback = (error?: Error | string | null, value?: unknown) => void;
type Listener = (event: Record<string, unknown>) => void;

type RustError = {
  code: string;
  message: string;
  details?: unknown;
};

type RustResponse = {
  ok: boolean;
  value?: unknown;
  error?: RustError | string;
};

const listeners = new Map<string, Set<Listener>>();

type WhipTerminalInboundTrace = {
  jsReceived: () => number | null;
};

function terminalInboundTrace(): WhipTerminalInboundTrace | undefined {
  return (globalThis as typeof globalThis & {
    __whipTerminalInboundTrace?: WhipTerminalInboundTrace;
  }).__whipTerminalInboundTrace;
}

function dispatchEvent(name: string, event: Record<string, unknown>): void {
  for (const listener of listeners.get(name) || []) listener(event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeError(value: unknown, fallback = 'Rust SSH operation failed'): Error {
  let error = value;
  if (typeof error === 'string' && error.startsWith('{')) {
    try {
      error = JSON.parse(error);
    } catch {
      // Older native builds return a plain error string.
    }
  }
  if (error && typeof error === 'object') {
    const payload = error as Partial<RustError>;
    const result = new Error(typeof payload.message === 'string' ? payload.message : fallback);
    result.name = 'SshError';
    if (typeof payload.code === 'string') Object.assign(result, { code: payload.code });
    if ('details' in payload) Object.assign(result, { details: payload.details });
    return result;
  }
  return new Error(typeof error === 'string' && error ? error : fallback);
}

function decodeResponse(responseJson: string): unknown {
  let response: RustResponse;
  try {
    response = JSON.parse(responseJson) as RustResponse;
  } catch {
    throw new Error('Rust SSH returned invalid JSON');
  }
  if (!response.ok) {
    throw decodeError(response.error);
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
  }).catch(error => callback(error instanceof Error ? error : decodeError(error)));
}

function finishSync(operation: string, params: Params, callback: Callback): void {
  try {
    const value = invokeSync(operation, params);
    if (value === undefined || value === null) callback();
    else callback(null, value);
  } catch (error) {
    callback(error instanceof Error ? error : decodeError(error));
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
  unixSocketChannelData(
    key: string,
    channelId: string,
    bytes: ArrayBuffer,
  ): void {
    const inboundTraceCookie = terminalInboundTrace()?.jsReceived() ?? null;
    dispatchEvent('UnixSocketChannel', {
      name: 'UnixSocketChannel',
      key,
      value: {
        type: 'data',
        channelId,
        bytes,
        inboundTraceCookie,
      },
    });
  },
  execChannelData(
    key: string,
    channelId: string,
    bytes: ArrayBuffer,
  ): void {
    dispatchEvent('ExecChannel', {
      name: 'ExecChannel',
      key,
      value: {
        type: 'data',
        channelId,
        bytes,
      },
    });
  },
};

function finishFast(operation: string, invoke: () => string | undefined, callback: Callback): void {
  try {
    const error = invoke();
    if (error) console.error(`[WhipSsh] ${operation} failed: ${error}`);
    callback(error ? decodeError(error) : undefined);
  } catch (error) {
    console.error(`[WhipSsh] ${operation} failed: ${errorMessage(error)}`);
    callback(error instanceof Error ? error : decodeError(error));
  }
}

// Product-only unit tests mock a narrow generated binding surface. Native
// builds always provide this export from the merged Whip crate.
if (typeof setEventSink === 'function') setEventSink(eventSink);

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
    finish(invokeAsync('generateKeyPair', { type: type || 'ed25519', passphrase: passphrase || '', keySize, comment: comment || 'whip-ssh' }), callback);
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
    finishFast('writeShellInput', () => writeShellInput(key, data), callback);
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

  sftpCreateDirAll(path: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpCreateDirAll', { path, key }), callback);
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

  sftpUpload(localPath: string, remoteDirectoryPath: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpUpload', { localPath, remotePath: remoteDirectoryPath, key }), callback);
  },

  sftpUploadToPath(localPath: string, remotePath: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpUploadToPath', { localPath, remotePath, key }), callback);
  },

  sftpDownload(remotePath: string, localPath: string, key: string, callback: Callback) {
    finish(invokeAsync('sftpDownload', { localPath, remotePath, key }), callback);
  },

  startSftpFileServer(remotePath: string, key: string, callback: Callback) {
    finish(invokeAsync('startSftpFileServer', { remotePath, key }), callback);
  },

  closeSftpFileServer(localPort: number, key: string, callback: Callback) {
    finishSync('closeSftpFileServer', { localPort, key }, callback);
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

  openLocalForward(remoteHost: string, remotePort: number, key: string, callback: Callback) {
    finish(invokeAsync('openLocalForward', { remoteHost, remotePort, key }), callback);
  },

  closeLocalForward(localPort: number, key: string, callback: Callback) {
    finishSync('closeLocalForward', { localPort, key }, callback);
  },

  openUnixSocketChannel(socketPath: string, channelId: string, key: string, callback: Callback) {
    finish(invokeAsync('openUnixSocketChannel', { socketPath, channelId, key }), callback);
  },

  openLengthPrefixedUnixSocketChannel(socketPath: string, channelId: string, lengthFormat: string, maxFrameBytes: number, key: string, callback: Callback) {
    finish(invokeAsync('openLengthPrefixedUnixSocketChannel', { socketPath, channelId, lengthFormat, maxFrameBytes, key }), callback);
  },

  writeUnixSocketChannel(channelId: string, bytes: ArrayBuffer, key: string, callback: Callback) {
    finishFast(
      'writeUnixSocketChannel',
      () => writeUnixSocketChannelRust(key, channelId, bytes),
      callback,
    );
  },

  writeLengthPrefixedUnixSocketChannel(channelId: string, bytes: ArrayBuffer, key: string, callback: Callback) {
    finishFast(
      'writeLengthPrefixedUnixSocketChannel',
      () => writeLengthPrefixedUnixSocketChannelRust(key, channelId, bytes),
      callback,
    );
  },

  closeUnixSocketChannel(channelId: string, key: string, callback: Callback) {
    finishSync('closeUnixSocketChannel', { channelId, key }, callback);
  },

  requestUnixSocket(socketPath: string, requestText: string, responseTerminator: string, timeoutMs: number, maxResponseBytes: number, key: string, callback: Callback) {
    finish(invokeAsync('requestUnixSocket', {
      socketPath,
      request: requestText,
      responseTerminator,
      timeoutMs,
      maxResponseBytes,
      key,
    }), callback);
  },

  openExecChannel(command: string, channelId: string, key: string, callback: Callback) {
    finish(invokeAsync('openExecChannel', { command, channelId, key }), callback);
  },

  writeExecChannel(channelId: string, bytes: ArrayBuffer, key: string, callback: Callback) {
    finishFast(
      'writeExecChannel',
      () => writeExecChannelRust(key, channelId, bytes),
      callback,
    );
  },

  closeExecChannel(channelId: string, key: string, callback: Callback) {
    finishSync('closeExecChannel', { channelId, key }, callback);
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
