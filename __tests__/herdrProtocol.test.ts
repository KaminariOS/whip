import {
  assertHerdrProtocolCompatible,
  HERDR_PROTOCOL_VERSION,
  HERDR_PROTOCOL_VERSIONS,
  HERDR_PROTOCOL_VERSIONS_LABEL,
  HerdrProtocolMismatchError,
  isHerdrProtocolMismatch,
} from '../src/lib/herdrProtocol';

describe('Herdr protocol compatibility', () => {
  test('accepts all protocols implemented by the Android bridge', () => {
    expect(HERDR_PROTOCOL_VERSION).toBe(19);
    expect(HERDR_PROTOCOL_VERSIONS).toEqual([17, 18, 19]);
    expect(HERDR_PROTOCOL_VERSIONS_LABEL).toBe('17–19');
    expect(() => assertHerdrProtocolCompatible(17)).not.toThrow();
    expect(() => assertHerdrProtocolCompatible(18)).not.toThrow();
    expect(() => assertHerdrProtocolCompatible(19)).not.toThrow();
    expect(() => assertHerdrProtocolCompatible(16)).toThrow(HerdrProtocolMismatchError);
    expect(() => assertHerdrProtocolCompatible(20)).toThrow(HerdrProtocolMismatchError);
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
