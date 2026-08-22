/* global TextDecoder */
/* eslint-disable no-bitwise */

import BaseSSHClient, { PtyType } from 'react-native-russh';
import {
  MAX_FRAME_BYTES,
  attach,
  decode,
  detach,
  encodeUtf8,
  hello,
  input,
  resize,
  scroll,
} from './herdr-codec';

export * from 'react-native-russh';
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

function bridgeEvent(message, terminalId) {
  const event = { type: message.kind, terminalId };
  if (message.kind === 'terminal') {
    Object.assign(event, {
      seq: message.sequence,
      width: message.width,
      height: message.height,
      full: message.full,
      bytes: message.bytes,
      final: true,
    });
  } else if (message.kind === 'graphics') event.bytes = message.bytes;
  else if (message.kind === 'closed' || message.kind === 'title') event.text = message.text;
  else if (message.kind === 'notify') {
    event.kind = message.notificationKind;
    event.text = message.text;
    event.body = message.body;
  } else if (message.kind === 'clipboard') event.text = message.text;
  else if (
    message.kind === 'mouse_capture'
    || message.kind === 'kitty_keyboard_report_all'
    || message.kind === 'prefix_input_source'
  ) event.flag = message.flag;
  else if (message.kind === 'terminal_bell') event.count = message.count;
  return event;
}

/** Whip's private Herdr adapter over the public product-neutral SSH client. */
class SSHClient extends BaseSSHClient {
  constructor(...args) {
    super(...args);
    this._activeStream.herdrEventStream = false;
    this._activeStream.herdrCommandStream = false;
    this._preparedHerdrBridge = null;
    this._herdrBridges = new Map();
    this._herdrEventChannel = null;
    this._herdrEventHandler = null;
    this._herdrEventDecode = null;
    this._herdrCommandChannel = null;
    this._herdrCommandHandler = null;
    this._herdrCommandDecode = null;
  }

  static connectWithKey(...args) { return super.connectWithKey(...args); }
  static connectWithKeyViaJump(...args) { return super.connectWithKeyViaJump(...args); }
  static connectWithPassword(...args) { return super.connectWithPassword(...args); }
  static connectWithPasswordViaJump(...args) { return super.connectWithPasswordViaJump(...args); }

  static pairHost(code, publicKey, deviceName) {
    return privateNativeClient().pairHost(code, publicKey, deviceName);
  }

  async _openHerdrBridge(socketPath, protocol, columns, rows, cellWidthPx, cellHeightPx) {
    let resolveWelcome;
    let rejectWelcome;
    let settled = false;
    const welcome = new Promise((resolvePromise, rejectPromise) => {
      resolveWelcome = resolvePromise;
      rejectWelcome = rejectPromise;
    });
    const state = { channel: null, protocol, terminalId: null, handler: null, closing: false };
    const fail = error => {
      if (settled) return;
      settled = true;
      rejectWelcome(error instanceof Error ? error : new Error(String(error)));
    };
    state.channel = await this.openLengthPrefixedUnixSocketChannel(
      socketPath,
      { lengthFormat: 'u32le', maxFrameBytes: MAX_FRAME_BYTES },
      event => {
        if (event.type === 'closed') {
          if (!settled) fail(new Error(`Herdr bridge closed before Welcome: ${event.reason}`));
          if (state.terminalId && !state.closing) {
            state.handler?.({ type: 'closed', terminalId: state.terminalId, text: event.reason });
            this._herdrBridges.delete(state.terminalId);
          }
          return;
        }
        let message;
        try {
          message = decode(event.bytes, protocol);
        } catch (error) {
          if (!settled) fail(error);
          else if (state.terminalId) {
            state.handler?.({ type: 'closed', terminalId: state.terminalId, text: String(error) });
          }
          state.channel?.close().catch(() => {});
          return;
        }
        if (!settled) {
          if (message.kind !== 'welcome') return fail(new Error('Herdr bridge did not send Welcome first'));
          if (message.error) return fail(new Error(`Herdr bridge rejected protocol ${protocol}: ${message.error}`));
          if (message.sequence !== protocol || message.encoding !== 1) {
            return fail(new Error(
              `Herdr bridge negotiation mismatch (protocol ${message.sequence}, encoding ${message.encoding})`,
            ));
          }
          settled = true;
          resolveWelcome();
          return;
        }
        if (!state.terminalId || message.kind === 'welcome') return;
        state.handler?.(bridgeEvent(message, state.terminalId));
        if (message.kind === 'closed') {
          state.closing = true;
          this._herdrBridges.delete(state.terminalId);
          state.channel?.close().catch(() => {});
        }
      },
    );
    try {
      await state.channel.write(hello(protocol, columns, rows, cellWidthPx, cellHeightPx));
      let timer;
      try {
        await Promise.race([
          welcome,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out waiting for Herdr Welcome')), 15_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return state;
    } catch (error) {
      state.closing = true;
      state.channel?.close().catch(() => {});
      throw error;
    }
  }

  prepareHerdrBridge(socketPath, protocol, columns, rows, cellWidthPx, cellHeightPx, callback) {
    if (this._preparedHerdrBridge) {
      if (callback) callback();
      return Promise.resolve();
    }
    return this._openHerdrBridge(socketPath, protocol, columns, rows, cellWidthPx, cellHeightPx)
      .then(state => {
        this._preparedHerdrBridge = state;
        if (callback) callback();
      })
      .catch(error => {
        if (callback) callback(error);
        throw error;
      });
  }

  async startHerdrBridge(
    socketPath,
    protocol,
    terminalId,
    takeover,
    columns,
    rows,
    cellWidthPx,
    cellHeightPx,
    handler,
    callback,
  ) {
    const active = this._herdrBridges.get(terminalId);
    if (active) {
      active.handler = handler;
      if (callback) callback();
      return;
    }
    let state = this._preparedHerdrBridge;
    this._preparedHerdrBridge = null;
    try {
      if (state && state.protocol !== protocol) {
        state.closing = true;
        await state.channel.close();
        state = null;
      }
      if (!state) {
        state = await this._openHerdrBridge(
          socketPath, protocol, columns, rows, cellWidthPx, cellHeightPx,
        );
      }
      state.terminalId = terminalId;
      state.handler = handler;
      this._herdrBridges.set(terminalId, state);
      await state.channel.write(attach(terminalId, takeover));
      if (callback) callback();
    } catch (error) {
      if (state) {
        state.closing = true;
        state.channel.close().catch(() => {});
      }
      this._herdrBridges.delete(terminalId);
      if (callback) callback(error);
      throw error;
    }
  }

  _herdrBridge(terminalId) {
    const state = this._herdrBridges.get(terminalId);
    if (!state) throw new Error(`Herdr bridge is not active for terminal ${terminalId}`);
    return state;
  }

  herdrBridgeInput(terminalId, text) {
    return this._herdrBridge(terminalId).channel.write(input(text));
  }

  herdrBridgeResize(terminalId, columns, rows, cellWidthPx = 0, cellHeightPx = 0) {
    return this._herdrBridge(terminalId).channel.write(
      resize(columns, rows, cellWidthPx, cellHeightPx),
    );
  }

  herdrBridgeScroll(terminalId, direction, lines, column, row, modifiers = 0) {
    return this._herdrBridge(terminalId).channel.write(
      scroll(direction === 'up', lines, column, row, modifiers),
    );
  }

  closeHerdrBridge(terminalId) {
    const state = this._herdrBridges.get(terminalId);
    if (!state) return;
    this._herdrBridges.delete(terminalId);
    state.closing = true;
    state.channel.write(detach())
      .catch(() => {})
      .finally(() => state.channel.close().catch(() => {}));
  }

  closeAllHerdrBridges() {
    const prepared = this._preparedHerdrBridge;
    this._preparedHerdrBridge = null;
    if (prepared) {
      prepared.closing = true;
      prepared.channel.close().catch(() => {});
    }
    for (const terminalId of [...this._herdrBridges.keys()]) this.closeHerdrBridge(terminalId);
  }

  startHerdrEventStream(socketPath, handler, callback) {
    this._herdrEventHandler = handler;
    if (this._herdrEventChannel) return Promise.resolve();
    this._herdrEventDecode = createUtf8Decoder();
    return this.openUnixSocketChannel(socketPath, event => {
      if (event.type === 'data') {
        const text = this._herdrEventDecode?.(event.bytes, true) || '';
        if (text) this._herdrEventHandler?.(text);
        return;
      }
      const tail = this._herdrEventDecode?.(new ArrayBuffer(0), false) || '';
      if (tail) this._herdrEventHandler?.(tail);
      this._herdrEventHandler?.(`${JSON.stringify({
        herdr_android_bridge_closed: true,
        reason: event.reason,
      })}\n`);
      this._herdrEventChannel = null;
      this._herdrEventDecode = null;
      this._activeStream.herdrEventStream = false;
    }).then(channel => {
      if (!channel.closed) {
        this._herdrEventChannel = channel;
        this._activeStream.herdrEventStream = true;
      }
      if (callback) callback();
    }).catch(error => {
      this._herdrEventHandler = null;
      this._herdrEventDecode = null;
      if (callback) callback(error);
      throw error;
    });
  }

  writeHerdrEventStream(value) {
    if (!this._herdrEventChannel) return Promise.reject(new Error('Herdr event stream is not active'));
    return this._herdrEventChannel.write(encodeUtf8(value).buffer);
  }

  closeHerdrEventStream() {
    const channel = this._herdrEventChannel;
    this._herdrEventChannel = null;
    this._herdrEventHandler = null;
    this._herdrEventDecode = null;
    this._activeStream.herdrEventStream = false;
    channel?.close().catch(() => {});
  }

  requestHerdrApi(socketPath, request) {
    return this.requestUnixSocket(socketPath, request).then(response => response.replace(/\r$/, ''));
  }

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
  }

  writeHerdrCommandStream(value) {
    if (!this._herdrCommandChannel) {
      return Promise.reject(new Error('Herdr command stream is not active'));
    }
    return this._herdrCommandChannel.write(encodeUtf8(value).buffer);
  }

  closeHerdrCommandStream() {
    const channel = this._herdrCommandChannel;
    this._herdrCommandChannel = null;
    this._herdrCommandHandler = null;
    this._herdrCommandDecode = null;
    this._activeStream.herdrCommandStream = false;
    channel?.close().catch(() => {});
  }

  disconnect() {
    this.closeAllHerdrBridges();
    this.closeHerdrEventStream();
    this.closeHerdrCommandStream();
    super.disconnect();
  }
}

export default SSHClient;
