import {
  assertHerdrProtocolCompatible,
  HERDR_PROTOCOL_VERSION,
  HERDR_PROTOCOL_VERSIONS,
  HERDR_PROTOCOL_VERSIONS_LABEL,
  HerdrProtocolMismatchError,
  herdrTerminalAttachLaunchMode,
  isHerdrProtocolMismatch,
} from '../src/lib/herdrProtocol';

describe('Herdr protocol compatibility', () => {
  test('accepts all protocols implemented by the Android bridge', () => {
    expect(HERDR_PROTOCOL_VERSION).toBe(20);
    expect(HERDR_PROTOCOL_VERSIONS).toEqual([17, 18, 19, 20]);
    expect(HERDR_PROTOCOL_VERSIONS_LABEL).toBe('17–20');
    expect(() => assertHerdrProtocolCompatible(17)).not.toThrow();
    expect(() => assertHerdrProtocolCompatible(18)).not.toThrow();
    expect(() => assertHerdrProtocolCompatible(19)).not.toThrow();
    expect(() => assertHerdrProtocolCompatible(20)).not.toThrow();
    expect(() => assertHerdrProtocolCompatible(16)).toThrow(HerdrProtocolMismatchError);
    expect(() => assertHerdrProtocolCompatible(21)).toThrow(HerdrProtocolMismatchError);
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

  test('uses the shifted terminal attach launch mode for Herdr 0.8.2 and newer', () => {
    expect(herdrTerminalAttachLaunchMode('0.7.5')).toBe(1);
    expect(herdrTerminalAttachLaunchMode('0.8.0')).toBe(1);
    expect(herdrTerminalAttachLaunchMode('0.8.2')).toBe(2);
    expect(herdrTerminalAttachLaunchMode('0.8.2-preview.1')).toBe(2);
    expect(herdrTerminalAttachLaunchMode('0.9.0')).toBe(2);
    expect(herdrTerminalAttachLaunchMode(undefined)).toBe(1);
    expect(herdrTerminalAttachLaunchMode('development')).toBe(1);
  });
});
