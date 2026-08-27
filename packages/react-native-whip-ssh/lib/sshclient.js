/* global TextDecoder */
/* eslint-disable no-bitwise */

import SSHClient, { PtyType } from './base-sshclient';

export * from './base-sshclient';
export { PtyType };

function privateNativeClient() {
  return require('../src').default;
}

function createUtf8Decoder() {
  if (typeof TextDecoder !== 'undefined') {
    const decoder = new TextDecoder();
    return (bytes, stream = true) => decoder.decode(bytes, { stream });
  }
  let pending = new Uint8Array(0);
  return (buffer, stream = true) => {
    const incoming = new Uint8Array(buffer);
    const bytes = new Uint8Array(pending.length + incoming.length);
    bytes.set(pending);
    bytes.set(incoming, pending.length);
    let end = bytes.length;
    if (stream && end > 0) {
      let lead = end - 1;
      while (lead > 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
      const first = bytes[lead];
      const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      if (lead + expected > end) end = lead;
    }
    pending = bytes.slice(end);
    let result = '';
    for (let index = 0; index < end;) {
      const first = bytes[index++];
      if (first < 0x80) {
        result += String.fromCodePoint(first);
        continue;
      }
      const length = first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      let codePoint = first & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
      let valid = index + length - 1 <= end;
      for (let offset = 1; valid && offset < length; offset++) {
        const next = bytes[index++];
        valid = (next & 0xc0) === 0x80;
        codePoint = (codePoint << 6) | (next & 0x3f);
      }
      result += valid ? String.fromCodePoint(codePoint) : '\ufffd';
    }
    return result;
  };
}

function encodeUtf8(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
  const encoded = unescape(encodeURIComponent(value));
  return Uint8Array.from(encoded, character => character.charCodeAt(0));
}

SSHClient.pairHost = function pairHost(code, publicKey, deviceName) {
  return privateNativeClient().pairHost(code, publicKey, deviceName);
};

SSHClient.setTrustedHostKeys = function setTrustedHostKeys(entries) {
  return privateNativeClient().setTrustedHostKeys(entries);
};

SSHClient.createHostRuntime = function createHostRuntime(config, lifecycleHandler) {
  return privateNativeClient().createHostRuntime(config, lifecycleHandler);
};

const disconnectSshClient = SSHClient.prototype.disconnect;

// Whip-specific conveniences augment the one SSH facade; there is no second
// client class or inherited native stack.
Object.assign(SSHClient.prototype, {

  prepareHerdrBridge(socketPath, protocol, columns, rows, cellWidthPx, cellHeightPx, callback) {
    return privateNativeClient()
      .prepareHerdrBridge(
        this._key,
        socketPath,
        protocol,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      )
      .then(() => {
        if (callback) callback();
      })
      .catch(error => {
        if (callback) callback(error);
        throw error;
      });
  },

  startHerdrBridge(
    socketPath,
    protocol,
    terminalId,
    takeover,
    columns,
    rows,
    cellWidthPx,
    cellHeightPx,
    handler,
    terminalAttachLaunchMode = 1,
    callback,
  ) {
    return privateNativeClient()
      .startHerdrBridge(
        this._key,
        socketPath,
        protocol,
        terminalId,
        takeover,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
        terminalAttachLaunchMode,
        handler,
      )
      .then(() => {
        if (callback) callback();
      })
      .catch(error => {
        if (callback) callback(error);
        throw error;
      });
  },

  herdrBridgeInput(terminalId, text) {
    return privateNativeClient().herdrBridgeInput(this._key, terminalId, text);
  },

  herdrBridgeResize(terminalId, columns, rows, cellWidthPx = 0, cellHeightPx = 0) {
    return privateNativeClient().herdrBridgeResize(
      this._key,
      terminalId,
      columns,
      rows,
      cellWidthPx,
      cellHeightPx,
    );
  },

  herdrBridgeScroll(terminalId, direction, lines, column, row, modifiers = 0) {
    return privateNativeClient().herdrBridgeScroll(
      this._key,
      terminalId,
      direction === 'up',
      lines,
      column,
      row,
      modifiers,
    );
  },

  closeHerdrBridge(terminalId) {
    privateNativeClient().closeHerdrBridge(this._key, terminalId);
  },

  closeAllHerdrBridges() {
    privateNativeClient().closeAllHerdrBridges(this._key);
  },

  startHerdrEventStream(socketPath, protocol, paneIds, handler, callback) {
    if (this._activeStream.herdrEventStream) return Promise.resolve();
    return privateNativeClient().startHerdrEventStream(
      this._key,
      socketPath,
      protocol,
      paneIds,
      event => {
        if (event.type === 'closed') this._activeStream.herdrEventStream = false;
        handler(event);
      },
    ).then(() => {
      this._activeStream.herdrEventStream = true;
      if (callback) callback();
    }).catch(error => {
      this._activeStream.herdrEventStream = false;
      if (callback) callback(error);
      throw error;
    });
  },

  closeHerdrEventStream() {
    this._activeStream.herdrEventStream = false;
    privateNativeClient().closeHerdrEventStream(this._key);
  },

  requestHerdrApi(socketPath, request) {
    return privateNativeClient().requestHerdrApi(this._key, socketPath, request);
  },

  startHerdrCommandStream(command, handler, callback) {
    this._herdrCommandHandler = handler;
    if (this._herdrCommandChannel) {
      if (callback) callback();
      return Promise.resolve();
    }
    this._herdrCommandDecode = createUtf8Decoder();
    return this.openExecChannel(command, event => {
      if (event.type === 'data') {
        const data = this._herdrCommandDecode?.(event.bytes, true) || '';
        if (data) this._herdrCommandHandler?.({ data, closed: false });
        return;
      }
      const data = this._herdrCommandDecode?.(new ArrayBuffer(0), false) || '';
      if (data) this._herdrCommandHandler?.({ data, closed: false });
      this._herdrCommandHandler?.({ closed: true, reason: event.reason });
      this._herdrCommandChannel = null;
      this._herdrCommandDecode = null;
      this._activeStream.herdrCommandStream = false;
    }).then(channel => {
      if (!channel.closed) {
        this._herdrCommandChannel = channel;
        this._activeStream.herdrCommandStream = true;
      }
      if (callback) callback();
    }).catch(error => {
      this._herdrCommandHandler = null;
      this._herdrCommandDecode = null;
      if (callback) callback(error);
      throw error;
    });
  },

  writeHerdrCommandStream(value) {
    if (!this._herdrCommandChannel) {
      return Promise.reject(new Error('Herdr command stream is not active'));
    }
    return this._herdrCommandChannel.write(encodeUtf8(value).buffer);
  },

  closeHerdrCommandStream() {
    const channel = this._herdrCommandChannel;
    this._herdrCommandChannel = null;
    this._herdrCommandHandler = null;
    this._herdrCommandDecode = null;
    this._activeStream.herdrCommandStream = false;
    channel?.close().catch(() => {});
  },

  disconnect() {
    this.closeAllHerdrBridges();
    this.closeHerdrEventStream();
    this.closeHerdrCommandStream();
    disconnectSshClient.call(this);
  }
});

export default SSHClient;
