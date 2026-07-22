import {
  assertHerdrProtocolCompatible,
  HERDR_PROTOCOL_VERSION,
  HerdrProtocolMismatchError,
  isHerdrProtocolMismatch,
} from '../src/lib/herdrProtocol';

describe('Herdr protocol compatibility', () => {
  test('accepts only the protocol implemented by the Android bridge', () => {
    expect(HERDR_PROTOCOL_VERSION).toBe(17);
    expect(() => assertHerdrProtocolCompatible(17)).not.toThrow();
    expect(() => assertHerdrProtocolCompatible(16)).toThrow(HerdrProtocolMismatchError);
    expect(() => assertHerdrProtocolCompatible(17, false)).toThrow(HerdrProtocolMismatchError);
  });

  test('classifies protocol mismatches as non-retryable connection errors', () => {
    let error: unknown;
    try {
      assertHerdrProtocolCompatible(16);
    } catch (caught) {
      error = caught;
    }
    expect(isHerdrProtocolMismatch(error)).toBe(true);
    expect(isHerdrProtocolMismatch(new Error('connection lost'))).toBe(false);
  });
});
