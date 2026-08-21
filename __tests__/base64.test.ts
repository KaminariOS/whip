import { arrayBufferToBase64 } from '../src/lib/base64';

function bytes(...values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

test.each([
  [bytes(), ''],
  [bytes(0x66), 'Zg=='],
  [bytes(0x66, 0x6f), 'Zm8='],
  [bytes(0x66, 0x6f, 0x6f), 'Zm9v'],
  [bytes(0, 255, 16, 32, 127), 'AP8QIH8='],
])('encodes raw terminal bytes as base64 at the WebView boundary', (input, expected) => {
  expect(arrayBufferToBase64(input)).toBe(expected);
});

test('encodes buffers larger than an output part', () => {
  const input = Uint8Array.from({ length: 20_000 }, (_, index) => index % 251);
  expect(arrayBufferToBase64(input.buffer)).toBe(Buffer.from(input).toString('base64'));
});

test('encodes only the addressed bytes of an ArrayBufferView', () => {
  const input = Uint8Array.from([9, 9, 1, 2, 3, 9]);
  expect(arrayBufferToBase64(input.subarray(2, 5))).toBe('AQID');
});
