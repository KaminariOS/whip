/* global globalThis */
/* eslint-disable no-bitwise */

import { performance } from 'node:perf_hooks';

import { decode } from '../packages/react-native-whip-ssh/lib/herdr-codec.js';

const PROTOCOL = 20;
const TARGET_BYTES = 256 * 1024 * 1024;

// The previous native codec extracted terminal bytes with
// `decoder.bytes()?.to_vec()`. `slice()` models that payload-sized ownership
// copy; the optimized operation calls the current decoder and retains its view.
// This intentionally excludes SSH decryption, UniFFI ownership, and WebView IO.

function unsigned(value) {
  if (value <= 250) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(251, value & 0xff, (value >>> 8) & 0xff);
  return Uint8Array.of(
    252,
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  );
}

function terminalFrame(payloadBytes) {
  const length = unsigned(payloadBytes);
  const header = Uint8Array.of(2, 42, 80, 24, 1, ...length);
  const frame = new Uint8Array(header.byteLength + payloadBytes);
  frame.set(header);
  for (let index = header.byteLength; index < frame.byteLength; index += 1) {
    frame[index] = index % 251;
  }
  return { frame, payloadOffset: header.byteLength };
}

function measure(name, payloadBytes, iterations, operation) {
  let checksum = 0;
  for (let index = 0; index < Math.min(iterations, 2000); index += 1) {
    const value = operation();
    checksum ^= value[0] || 0;
    checksum ^= value[value.byteLength - 1] || 0;
  }
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const value = operation();
    checksum ^= value[index % value.byteLength] || 0;
  }
  const elapsedMs = performance.now() - started;
  const mibPerSecond = (payloadBytes * iterations) / (1024 * 1024) / (elapsedMs / 1000);
  return { name, elapsedMs, mibPerSecond, checksum };
}

console.log('Terminal bridge codec benchmark (copy-equivalent native baseline)');
console.log('Node', process.version);
console.log('size\tprevious native copy\tgeneric + JS view\tspeedup');

for (const payloadBytes of [4 * 1024, 64 * 1024, 1024 * 1024]) {
  const { frame, payloadOffset } = terminalFrame(payloadBytes);
  const iterations = Math.max(256, Math.floor(TARGET_BYTES / payloadBytes));
  const previous = measure('previous', payloadBytes, iterations, () => (
    frame.slice(payloadOffset)
  ));
  const optimized = measure('optimized', payloadBytes, iterations, () => (
    decode(frame, PROTOCOL).bytes
  ));
  if (previous.checksum !== optimized.checksum) {
    throw new Error(`benchmark paths disagreed for ${payloadBytes} bytes`);
  }
  const speedup = previous.elapsedMs / optimized.elapsedMs;
  console.log(
    `${payloadBytes}\t${previous.mibPerSecond.toFixed(1)} MiB/s\t\t`
      + `${optimized.mibPerSecond.toFixed(1)} MiB/s\t\t${speedup.toFixed(2)}x`
  );
}
