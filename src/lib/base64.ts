/* eslint-disable no-bitwise -- Base64 packs bytes into six-bit indices. */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const OUTPUT_PART_SIZE = 16_384;

/** Encodes bridge bytes only at the WebView boundary, where a string is required. */
export function arrayBufferToBase64(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  const parts: string[] = [];
  let part = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    part += BASE64_ALPHABET[first >> 2]
      + BASE64_ALPHABET[((first & 3) << 4) | (second >> 4)]
      + (hasSecond ? BASE64_ALPHABET[((second & 15) << 2) | (third >> 6)] : '=')
      + (hasThird ? BASE64_ALPHABET[third & 63] : '=');
    if (part.length >= OUTPUT_PART_SIZE) {
      parts.push(part);
      part = '';
    }
  }
  if (part) parts.push(part);
  return parts.join('');
}
