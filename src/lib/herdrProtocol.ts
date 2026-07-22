/** Wire protocol implemented by the bundled Android Herdr bridge codec. */
export const HERDR_PROTOCOL_VERSION = 17;

export class HerdrProtocolMismatchError extends Error {
  readonly expected: number;
  readonly received: number | undefined;

  constructor(received: number | undefined) {
    const actual = received === undefined ? 'unavailable' : String(received);
    super(`Herdr protocol mismatch: Whip supports ${HERDR_PROTOCOL_VERSION}, server reports ${actual}`);
    this.name = 'HerdrProtocolMismatchError';
    this.expected = HERDR_PROTOCOL_VERSION;
    this.received = received;
  }
}

export function assertHerdrProtocolCompatible(
  protocol: number | undefined,
  serverCompatible = true,
): asserts protocol is number {
  if (!serverCompatible || protocol !== HERDR_PROTOCOL_VERSION) {
    throw new HerdrProtocolMismatchError(protocol);
  }
}

export function isHerdrProtocolMismatch(error: unknown): boolean {
  return error instanceof HerdrProtocolMismatchError;
}
