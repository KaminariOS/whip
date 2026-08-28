import {
  cancelSshSftpDownload,
  cancelSshSftpUpload,
  chmodSshSftpPath,
  clearEventSink,
  closeSshExecChannel,
  closeSshLocalForward,
  closeSshSftpFileServer,
  closeSshShell,
  closeSshUnixSocketChannel,
  connectSsh,
  connectSshSftp,
  createSshSftpDirectory,
  createSshSftpDirectoryAll,
  disconnectSsh,
  disconnectSshSftp,
  downloadSshSftp,
  executeSshCommand,
  generateSshKeyPair,
  getSshKeyDetails,
  getSshRemoteHome,
  listSshSftpDirectory,
  measureSshHostLatency,
  openLengthPrefixedSshUnixSocketChannel,
  openSshExecChannel,
  openSshLocalForward,
  openSshUnixSocketChannel,
  removeSshSftpDirectory,
  removeSshSftpFile,
  renameSshSftpPath,
  requestSshUnixSocket,
  resizeShellFast,
  setKnownHosts,
  setSshAgentForwarding,
  setEventSink,
  shutdown as shutdownRust,
  SshAuthentication,
  startSshSftpFileServer,
  startSshShell,
  uploadSshSftp,
  uploadSshSftpToPath,
  type WhipSshEventSink,
  writeUnixSocketChannel as writeUnixSocketChannelRust,
  writeLengthPrefixedUnixSocketChannel as writeLengthPrefixedUnixSocketChannelRust,
  writeExecChannel as writeExecChannelRust,
  writeShellInput,
} from './generated-entry';

export * from './generated-entry';

type Callback = (error?: Error | string | null, value?: unknown) => void;
type Listener = (event: Record<string, unknown>) => void;

type LegacyKey = { privateKey?: string; passphrase?: string | null };

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

const SSH_ERROR_CODES = {
  AuthenticationFailed: 'AUTHENTICATION_FAILED',
  HostKeyUnknown: 'HOST_KEY_UNKNOWN',
  HostKeyChanged: 'HOST_KEY_CHANGED',
  UnsupportedHostCertificate: 'UNSUPPORTED_HOST_CERTIFICATE',
  ConnectionRefused: 'CONNECTION_REFUSED',
  ConnectionTimeout: 'CONNECTION_TIMEOUT',
  HostUnreachable: 'HOST_UNREACHABLE',
  ChannelUnavailable: 'CHANNEL_UNAVAILABLE',
  SessionClosed: 'SESSION_CLOSED',
  InvalidPrivateKey: 'INVALID_PRIVATE_KEY',
  SftpFailure: 'SFTP_FAILURE',
  InvalidRequest: 'INVALID_REQUEST',
  Unknown: 'UNKNOWN',
} as const;

function sshError(error: unknown): Error {
  if (error instanceof Error && error.name === 'SshError') return error;
  const native = error as { tag?: keyof typeof SSH_ERROR_CODES; inner?: readonly unknown[] };
  const tag = native?.tag;
  const details = tag === 'HostKeyUnknown' || tag === 'HostKeyChanged'
    ? native.inner?.[0]
    : undefined;
  const message = tag === 'HostKeyUnknown'
    ? 'unknown SSH host key'
    : tag === 'HostKeyChanged'
      ? 'SSH host key changed'
      : tag === 'UnsupportedHostCertificate'
        ? 'SSH host certificates are not supported'
        : typeof native?.inner?.[0] === 'string'
          ? native.inner[0]
          : error instanceof Error
            ? error.message
            : String(error);
  const result = error instanceof Error ? error : new Error(message);
  result.message = message;
  result.name = 'SshError';
  if (tag) Object.assign(result, { code: SSH_ERROR_CODES[tag] });
  if (details) Object.assign(result, { details });
  return result;
}

async function logged<T>(label: string, promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    const converted = sshError(error);
    console.error(`[WhipSsh] ${label} failed: ${converted.message}`);
    throw converted;
  }
}

function finish(promise: Promise<unknown>, callback: Callback, select?: (value: any) => unknown): void {
  promise.then(value => {
    const selected = select ? select(value) : value;
    if (selected === undefined || selected === null) callback();
    else callback(null, selected);
  }).catch(error => callback(sshError(error)));
}

function finishSync(invoke: () => unknown, callback: Callback): void {
  try {
    const value = invoke();
    if (value === undefined || value === null) callback();
    else callback(null, value);
  } catch (error) {
    callback(sshError(error));
  }
}

function fireSync(invoke: () => void): void {
  try {
    invoke();
  } catch {
    // Matches the legacy void native methods, which cannot report failures.
  }
}

function bestEffortCleanup(
  promise: Promise<unknown>,
  _context: string,
): void {
  // eslint-disable-next-line no-restricted-syntax -- Legacy disconnect intentionally ignores cleanup failures.
  promise.catch(() => undefined);
}

function credential(passwordOrKey: string | LegacyKey) {
  return typeof passwordOrKey === 'string'
    ? SshAuthentication.Password.new({ password: passwordOrKey })
    : SshAuthentication.Key.new({
        privateKey: passwordOrKey.privateKey || '',
        passphrase: passwordOrKey.passphrase ?? undefined,
      });
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

function finishFast(label: string, invoke: () => void, callback: Callback): void {
  try {
    invoke();
    callback();
  } catch (error) {
    const converted = sshError(error);
    console.error(`[WhipSsh] ${label} failed: ${converted.message}`);
    callback(converted);
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
    fireSync(() => setKnownHosts(contents || ''));
  },

  getKeyDetails(privateKey: string, passphrase: string | null) {
    return Promise.resolve().then(() => getSshKeyDetails(privateKey || '', passphrase ?? undefined)).catch(error => {
      throw sshError(error);
    });
  },

  generateKeyPair(type: string, passphrase: string, keySize: number, comment: string, callback: Callback) {
    finish(Promise.resolve().then(() => generateSshKeyPair(
      type || 'ed25519',
      passphrase || '',
      keySize,
      comment || 'whip-ssh',
    )), callback);
  },

  connectToHost(host: string, port: number, username: string, passwordOrKey: string | LegacyKey, key: string, callback: Callback) {
    finish(logged('connectSsh', connectSsh(host, port, username, credential(passwordOrKey), key, undefined)), callback);
  },

  connectToHostByPasswordViaJump(host: string, port: number, username: string, password: string, jumpKey: string, key: string, callback: Callback) {
    finish(logged('connectSsh', connectSsh(host, port, username, credential(password), key, jumpKey)), callback);
  },

  connectToHostByKeyViaJump(host: string, port: number, username: string, keyData: LegacyKey, jumpKey: string, key: string, callback: Callback) {
    finish(logged('connectSsh', connectSsh(host, port, username, credential(keyData), key, jumpKey)), callback);
  },

  setAgentForwarding(key: string, enabled: boolean) {
    fireSync(() => setSshAgentForwarding(key, enabled));
  },

  execute(command: string, key: string, callback: Callback) {
    finish(logged('executeSshCommand', executeSshCommand(key, command)), callback);
  },

  startShell(key: string, ptyType: string, callback: Callback) {
    finish(logged('startSshShell', startSshShell(key, ptyType || 'xterm-256color')), callback);
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
    fireSync(() => closeSshShell(key));
  },

  measureHostLatency(key: string, callback: Callback) {
    finish(logged('measureSshHostLatency', measureSshHostLatency(key)), callback);
  },

  getRemoteHome(key: string, callback: Callback) {
    finish(logged('getSshRemoteHome', getSshRemoteHome(key)), callback);
  },

  disconnect(key: string) {
    bestEffortCleanup(disconnectSsh(key), 'legacy-ssh-disconnect');
  },

  connectSFTP(key: string, callback: Callback) {
    finish(logged('connectSshSftp', connectSshSftp(key)), callback);
  },

  sftpLs(path: string, key: string, callback: Callback) {
    finish(logged('listSshSftpDirectory', listSshSftpDirectory(key, path)).then(entries => entries.map(entry => ({
      filename: entry.filename,
      isDirectory: entry.isDirectory,
      modificationDate: entry.modificationDate,
      lastAccess: entry.lastAccess,
      fileSize: Number(entry.fileSize),
      ownerUserID: entry.ownerUserId,
      ownerGroupID: entry.ownerGroupId,
      permissions: entry.permissions,
      flags: entry.flags,
    }))), callback);
  },

  sftpMkdir(path: string, key: string, callback: Callback) {
    finish(logged('createSshSftpDirectory', createSshSftpDirectory(key, path)), callback);
  },

  sftpCreateDirAll(path: string, key: string, callback: Callback) {
    finish(logged('createSshSftpDirectoryAll', createSshSftpDirectoryAll(key, path)), callback);
  },

  sftpRm(path: string, key: string, callback: Callback) {
    finish(logged('removeSshSftpFile', removeSshSftpFile(key, path)), callback);
  },

  sftpRmdir(path: string, key: string, callback: Callback) {
    finish(logged('removeSshSftpDirectory', removeSshSftpDirectory(key, path)), callback);
  },

  sftpRename(oldPath: string, newPath: string, key: string, callback: Callback) {
    finish(logged('renameSshSftpPath', renameSshSftpPath(key, oldPath, newPath)), callback);
  },

  sftpChmod(path: string, permissions: number, key: string, callback: Callback) {
    finish(logged('chmodSshSftpPath', chmodSshSftpPath(key, path, permissions)), callback);
  },

  sftpUpload(localPath: string, remoteDirectoryPath: string, key: string, callback: Callback) {
    finish(logged('uploadSshSftp', uploadSshSftp(key, localPath, remoteDirectoryPath)), callback);
  },

  sftpUploadToPath(localPath: string, remotePath: string, key: string, callback: Callback) {
    finish(logged('uploadSshSftpToPath', uploadSshSftpToPath(key, localPath, remotePath)), callback);
  },

  sftpDownload(remotePath: string, localPath: string, key: string, callback: Callback) {
    finish(logged('downloadSshSftp', downloadSshSftp(key, remotePath, localPath)), callback);
  },

  startSftpFileServer(remotePath: string, key: string, callback: Callback) {
    finish(logged('startSshSftpFileServer', startSshSftpFileServer(key, remotePath)), callback);
  },

  closeSftpFileServer(localPort: number, key: string, callback: Callback) {
    finishSync(() => closeSshSftpFileServer(key, localPort), callback);
  },

  sftpCancelUpload(key: string) {
    cancelSshSftpUpload(key);
  },

  sftpCancelDownload(key: string) {
    cancelSshSftpDownload(key);
  },

  disconnectSFTP(key: string) {
    bestEffortCleanup(disconnectSshSftp(key), 'legacy-sftp-disconnect');
  },

  openLocalForward(remoteHost: string, remotePort: number, key: string, callback: Callback) {
    finish(logged('openSshLocalForward', openSshLocalForward(key, remoteHost, remotePort)), callback);
  },

  closeLocalForward(localPort: number, key: string, callback: Callback) {
    finishSync(() => closeSshLocalForward(key, localPort), callback);
  },

  openUnixSocketChannel(socketPath: string, channelId: string, key: string, callback: Callback) {
    finish(logged('openSshUnixSocketChannel', openSshUnixSocketChannel(key, socketPath, channelId)), callback);
  },

  openLengthPrefixedUnixSocketChannel(socketPath: string, channelId: string, lengthFormat: string, maxFrameBytes: number, key: string, callback: Callback) {
    finish(logged('openLengthPrefixedSshUnixSocketChannel', openLengthPrefixedSshUnixSocketChannel(
      key,
      socketPath,
      channelId,
      lengthFormat,
      maxFrameBytes,
    )), callback);
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
    finishSync(() => closeSshUnixSocketChannel(key, channelId), callback);
  },

  requestUnixSocket(socketPath: string, requestText: string, responseTerminator: string, timeoutMs: number, maxResponseBytes: number, key: string, callback: Callback) {
    finish(logged('requestSshUnixSocket', requestSshUnixSocket(
      key,
      socketPath,
      requestText,
      responseTerminator,
      timeoutMs,
      maxResponseBytes,
    )), callback);
  },

  openExecChannel(command: string, channelId: string, key: string, callback: Callback) {
    finish(logged('openSshExecChannel', openSshExecChannel(key, command, channelId)), callback);
  },

  writeExecChannel(channelId: string, bytes: ArrayBuffer, key: string, callback: Callback) {
    finishFast(
      'writeExecChannel',
      () => writeExecChannelRust(key, channelId, bytes),
      callback,
    );
  },

  closeExecChannel(channelId: string, key: string, callback: Callback) {
    finishSync(() => closeSshExecChannel(key, channelId), callback);
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
