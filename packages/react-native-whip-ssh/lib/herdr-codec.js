/* global BigInt, TextDecoder, TextEncoder */
/* eslint-disable no-bitwise */

export const MIN_PROTOCOL = 17;
export const MAX_PROTOCOL = 20;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function encodeUtf8(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
  const encoded = unescape(encodeURIComponent(value));
  return Uint8Array.from(encoded, character => character.charCodeAt(0));
}

function decodeUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let encoded = '';
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return decodeURIComponent(escape(encoded));
}

function checkProtocol(protocol) {
  if (protocol < MIN_PROTOCOL || protocol > MAX_PROTOCOL) {
    throw new Error(
      `Herdr protocol mismatch: client supports ${MIN_PROTOCOL} through ${MAX_PROTOCOL}, server reports ${protocol}`,
    );
  }
}

class Encoder {
  constructor() {
    this.bytes = [];
  }
  unsigned(value) {
    const number = Number(value);
    if (number <= 250) this.bytes.push(number);
    else if (number <= 0xffff) {
      this.bytes.push(251, number & 0xff, (number >>> 8) & 0xff);
    } else if (number <= 0xffffffff) {
      this.bytes.push(
        252,
        number & 0xff,
        (number >>> 8) & 0xff,
        (number >>> 16) & 0xff,
        (number >>> 24) & 0xff,
      );
    } else {
      let remaining = BigInt(value);
      this.bytes.push(253);
      for (let index = 0; index < 8; index++) {
        this.bytes.push(Number(remaining & 0xffn));
        remaining >>= 8n;
      }
    }
  }
  byte(value) {
    this.bytes.push(value & 0xff);
  }
  boolean(value) {
    this.byte(value ? 1 : 0);
  }
  byteString(value) {
    const bytes = typeof value === 'string' ? encodeUtf8(value) : value;
    this.unsigned(bytes.byteLength);
    this.bytes.push(...bytes);
  }
  finish() {
    return Uint8Array.from(this.bytes).buffer;
  }
}

class Decoder {
  constructor(buffer) {
    this.bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    this.offset = 0;
  }
  byte(message = 'unexpected end of bincode payload') {
    if (this.offset >= this.bytes.length) throw new Error(message);
    return this.bytes[this.offset++];
  }
  take(length, message = 'unexpected end of bincode payload') {
    const end = this.offset + length;
    if (end > this.bytes.length) throw new Error(message);
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }
  unsigned() {
    const marker = this.byte();
    if (marker <= 250) return marker;
    const width = marker === 251 ? 2 : marker === 252 ? 4 : marker === 253 ? 8 : 0;
    if (!width) throw new Error(`unsupported bincode integer marker ${marker}`);
    const bytes = this.take(width, 'unexpected end of bincode integer');
    let value = 0n;
    for (let index = width - 1; index >= 0; index--) {
      value = (value << 8n) | BigInt(bytes[index]);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('bincode value exceeds JavaScript integer range');
    return number;
  }
  boolean() {
    const value = this.byte();
    if (value > 1) throw new Error(`invalid bincode bool ${value}`);
    return value === 1;
  }
  byteString() {
    const length = this.unsigned();
    return this.take(length, `invalid bincode byte length ${length}`);
  }
  string() {
    return decodeUtf8(this.byteString());
  }
  optionString() {
    const tag = this.byte();
    if (tag === 0) return undefined;
    if (tag === 1) return this.string();
    throw new Error(`invalid bincode option tag ${tag}`);
  }
}

function payload(encode) {
  const encoder = new Encoder();
  encode(encoder);
  return encoder.finish();
}

export function hello(protocol, columns, rows, cellWidth, cellHeight, terminalAttachLaunchMode = 1) {
  checkProtocol(protocol);
  if (terminalAttachLaunchMode !== 1 && terminalAttachLaunchMode !== 2) {
    throw new Error(`unsupported Herdr terminal attach launch mode ${terminalAttachLaunchMode}`);
  }
  return payload(encoder => {
    encoder.unsigned(0);
    encoder.unsigned(protocol);
    encoder.unsigned(columns);
    encoder.unsigned(rows);
    encoder.unsigned(cellWidth);
    encoder.unsigned(cellHeight);
    encoder.unsigned(1); // TerminalAnsi
    encoder.unsigned(0); // Server keybindings
    encoder.unsigned(terminalAttachLaunchMode);
  });
}

export const input = text => payload(encoder => {
  encoder.unsigned(1);
  encoder.byteString(text);
});

export const resize = (columns, rows, cellWidth, cellHeight) => payload(encoder => {
  encoder.unsigned(3);
  encoder.unsigned(columns);
  encoder.unsigned(rows);
  encoder.unsigned(cellWidth);
  encoder.unsigned(cellHeight);
});

export const detach = () => Uint8Array.of(4).buffer;

export const attach = (terminalId, takeover) => payload(encoder => {
  encoder.unsigned(5);
  encoder.byteString(terminalId);
  encoder.boolean(takeover);
});

export const scroll = (up, lines, column, row, modifiers = 0) => payload(encoder => {
  encoder.unsigned(6);
  encoder.unsigned(0);
  encoder.unsigned(up ? 0 : 1);
  encoder.unsigned(lines);
  if (Number.isFinite(column)) {
    encoder.byte(1);
    encoder.unsigned(Math.max(0, Math.round(column)));
  } else encoder.byte(0);
  if (Number.isFinite(row)) {
    encoder.byte(1);
    encoder.unsigned(Math.max(0, Math.round(row)));
  } else encoder.byte(0);
  encoder.byte(modifiers);
});

export function decode(buffer, protocol) {
  checkProtocol(protocol);
  const decoder = new Decoder(buffer);
  const variant = decoder.unsigned();
  const kind = variant === 0 ? 'welcome'
    : variant === 2 ? 'terminal'
      : variant === 3 ? 'graphics'
        : variant === 4 ? 'closed'
          : variant === 5 ? 'notify'
            : variant === 6 ? 'clipboard'
              : variant === 7 ? 'title'
                : variant === 8 ? 'reload_sound_config'
                  : variant === 9 ? 'mouse_capture'
                    : variant === 10 && protocol === 17 ? 'prefix_input_source'
                      : variant === 10 ? 'kitty_keyboard_report_all'
                        : variant === 11 && protocol >= 18 ? 'prefix_input_source'
                          : variant === 12 && protocol >= 20 ? 'terminal_bell'
                            : 'ignored';
  const message = { kind };
  if (kind === 'welcome') {
    message.sequence = decoder.unsigned();
    message.encoding = decoder.unsigned();
    message.error = decoder.optionString();
  } else if (kind === 'terminal') {
    message.sequence = decoder.unsigned();
    message.width = decoder.unsigned();
    message.height = decoder.unsigned();
    message.full = decoder.boolean();
    message.bytes = decoder.byteString();
  } else if (kind === 'graphics') {
    message.bytes = decoder.byteString();
  } else if (kind === 'closed' || kind === 'title') {
    message.text = decoder.optionString();
  } else if (kind === 'notify') {
    message.notificationKind = decoder.unsigned();
    message.text = decoder.string();
    message.body = decoder.optionString();
  } else if (kind === 'clipboard') {
    message.text = decoder.string();
  } else if (
    kind === 'mouse_capture'
    || kind === 'kitty_keyboard_report_all'
    || kind === 'prefix_input_source'
  ) {
    message.flag = decoder.boolean();
  } else if (kind === 'terminal_bell') {
    message.count = decoder.unsigned();
    if (message.count > 0xffff) throw new Error(`invalid Herdr terminal bell count ${message.count}`);
  }
  return message;
}
