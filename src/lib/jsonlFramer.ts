/* eslint-disable no-bitwise -- UTF-8 framing decodes byte-level bit fields. */

export interface JsonlFramerHandlers<T> {
  onRecord: (record: T, metadata: JsonlRecordMetadata) => void;
  onMalformed?: (line: string, error: unknown, metadata: JsonlRecordMetadata) => void;
  onBlank?: (metadata: JsonlRecordMetadata) => void;
}

export interface JsonlRecordMetadata {
  /** JSON text without the trailing LF or optional CR. */
  rawLine: string;
  /** Original wire bytes for this physical line, including CRLF/LF. */
  consumedBytes: number;
}

/** Frames newline-delimited JSON from arbitrary SSH binary chunks. */
export class JsonlFramer<T = unknown> {
  private buffered = new Uint8Array();

  constructor(private readonly handlers: JsonlFramerHandlers<T>) {}

  push(chunk: ArrayBuffer | ArrayBufferView): void {
    const bytes = chunk instanceof ArrayBuffer
      ? new Uint8Array(chunk)
      : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (bytes.byteLength) {
      const joined = new Uint8Array(this.buffered.byteLength + bytes.byteLength);
      joined.set(this.buffered);
      joined.set(bytes, this.buffered.byteLength);
      this.buffered = joined;
    }
    this.drain();
  }

  end(): void {
    this.drain();
    // An unterminated final line may still be in the middle of an SSH write.
    this.buffered = new Uint8Array();
  }

  private drain(): void {
    let newline = this.buffered.indexOf(0x0a);
    while (newline >= 0) {
      const consumedBytes = newline + 1;
      let lineBytes = this.buffered.slice(0, newline);
      if (lineBytes[lineBytes.byteLength - 1] === 0x0d) lineBytes = lineBytes.slice(0, -1);
      const line = this.decodeUtf8(lineBytes);
      this.buffered = this.buffered.slice(newline + 1);
      const metadata = { rawLine: line, consumedBytes };
      if (line.trim()) {
        try {
          this.handlers.onRecord(JSON.parse(line) as T, metadata);
        } catch (error) {
          this.handlers.onMalformed?.(line, error, metadata);
        }
      } else this.handlers.onBlank?.(metadata);
      newline = this.buffered.indexOf(0x0a);
    }
  }

  /** Hermes does not currently expose TextDecoder, so decode complete line bytes here. */
  private decodeUtf8(bytes: Uint8Array): string {
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
        output += '\ufffd';
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
