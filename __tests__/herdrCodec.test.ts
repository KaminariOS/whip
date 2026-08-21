import {
  attach,
  decode,
  hello,
  input,
  resize,
  scroll,
} from '../packages/react-native-whip-ssh/lib/herdr-codec';

const bytes = (buffer: ArrayBuffer | ArrayBufferView) => [
  ...(ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer)),
];

describe('private Herdr codec', () => {
  it('encodes payloads without the generic channel length prefix', () => {
    expect(bytes(hello(20, 80, 24, 8, 16))).toEqual([
      0, 20, 80, 24, 8, 16, 1, 0, 1,
    ]);
    expect(bytes(input('hi'))).toEqual([1, 2, 104, 105]);
    expect(bytes(attach('t1', true))).toEqual([5, 2, 116, 49, 1]);
    expect(bytes(resize(80, 24, 8, 16))).toEqual([3, 80, 24, 8, 16]);
    expect(bytes(scroll(true, 3))).toEqual([6, 0, 0, 3, 0, 0, 0]);
  });

  it('decodes terminal payloads into private terminal events', () => {
    const frame = Uint8Array.from([2, 42, 80, 24, 1, 3, 97, 98, 99]);
    const message = decode(
      frame.buffer,
      20,
    );
    expect(message).toMatchObject({
      kind: 'terminal',
      sequence: 42,
      width: 80,
      height: 24,
      full: true,
    });
    const terminalBytes = message.bytes!;
    expect(bytes(terminalBytes)).toEqual([97, 98, 99]);
    expect(terminalBytes).toBeInstanceOf(Uint8Array);
    expect(terminalBytes.buffer).toBe(frame.buffer);
    expect(terminalBytes.byteOffset).toBe(6);
    expect(terminalBytes.byteLength).toBe(3);
  });

  it('rejects unsupported protocol versions', () => {
    expect(() => hello(16, 80, 24, 8, 16)).toThrow(
      'client supports 17 through 20',
    );
  });
});
