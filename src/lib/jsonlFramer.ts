/* eslint-disable no-bitwise -- UTF-8 framing decodes byte-level bit fields. */

export interface JsonlFramerHandlers<T> {
  onRecord: (record: T) => void;
  onMalformed?: (line: string, error: unknown) => void;
}

/** Frames newline-delimited JSON from arbitrary SSH binary chunks. */
export class JsonlFramer<T = unknown> {
  private buffered = '';
  private pendingUtf8: number[] = [];

  constructor(private readonly handlers: JsonlFramerHandlers<T>) {}

  push(chunk: ArrayBuffer | ArrayBufferView): void {
    const bytes = chunk instanceof ArrayBuffer
      ? new Uint8Array(chunk)
      : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.buffered += this.decodeUtf8(bytes, false);
    this.drain();
  }

  end(): void {
    this.buffered += this.decodeUtf8(new Uint8Array(), true);
    this.drain();
    // An unterminated final line may still be in the middle of an SSH write.
    this.buffered = '';
  }

  private drain(): void {
    let newline = this.buffered.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline).replace(/\r$/, '');
      this.buffered = this.buffered.slice(newline + 1);
      if (line.trim()) {
        try {
          this.handlers.onRecord(JSON.parse(line) as T);
        } catch (error) {
          this.handlers.onMalformed?.(line, error);
        }
      }
      newline = this.buffered.indexOf('\n');
    }
  }

  /** Hermes does not currently expose TextDecoder, so retain incomplete code points here. */
  private decodeUtf8(chunk: Uint8Array, final: boolean): string {
    const bytes = this.pendingUtf8.length
      ? Uint8Array.from([...this.pendingUtf8, ...chunk])
      : chunk;
    this.pendingUtf8 = [];
    let output = '';
    let index = 0;
    while (index < bytes.length) {
      const first = bytes[index];
      if (first < 0x80) {
        output += String.fromCodePoint(first);
        index += 1;
        continue;
      }
      const length = first >= 0xc2 && first <= 0xdf ? 2
        : first >= 0xe0 && first <= 0xef ? 3
          : first >= 0xf0 && first <= 0xf4 ? 4
            : 0;
      if (!length) {
        output += '\ufffd';
        index += 1;
        continue;
      }
      if (index + length > bytes.length) {
        if (!final) this.pendingUtf8 = Array.from(bytes.slice(index));
        else output += '\ufffd';
        break;
      }
      const continuation = Array.from(bytes.slice(index + 1, index + length));
      if (continuation.some(value => (value & 0xc0) !== 0x80)) {
        output += '\ufffd';
        index += 1;
        continue;
      }
      let codePoint = first & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
      for (const value of continuation) codePoint = (codePoint << 6) | (value & 0x3f);
      const invalid = (length === 3 && codePoint < 0x800)
        || (length === 4 && codePoint < 0x10000)
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        || codePoint > 0x10ffff;
      output += invalid ? '\ufffd' : String.fromCodePoint(codePoint);
      index += length;
    }
    return output;
  }
}
