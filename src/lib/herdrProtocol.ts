import type { SupportedHerdrProtocol } from '../generated/herdrApi';

/** Wire protocols implemented by the bundled Android Herdr bridge codec. */
export const HERDR_PROTOCOL_VERSIONS = [17, 18, 19, 20] as const satisfies readonly SupportedHerdrProtocol[];
export const HERDR_PROTOCOL_VERSION = HERDR_PROTOCOL_VERSIONS.at(-1)!;
export const HERDR_PROTOCOL_VERSIONS_LABEL = `${HERDR_PROTOCOL_VERSIONS[0]}–${HERDR_PROTOCOL_VERSION}`;
export type HerdrProtocolVersion = typeof HERDR_PROTOCOL_VERSIONS[number];

export class HerdrProtocolMismatchError extends Error {
  readonly expected: string;
  readonly received: number | undefined;

  constructor(received: number | undefined) {
    const actual = received === undefined ? 'unavailable' : String(received);
    super(`Herdr protocol mismatch: Whip supports ${HERDR_PROTOCOL_VERSIONS_LABEL}, server reports ${actual}`);
    this.name = 'HerdrProtocolMismatchError';
    this.expected = HERDR_PROTOCOL_VERSIONS_LABEL;
    this.received = received;
  }
}

export function assertHerdrProtocolCompatible(
  protocol: number | undefined,
  serverCompatible = true,
): asserts protocol is HerdrProtocolVersion {
  if (
    !serverCompatible
    || protocol === undefined
    || !(HERDR_PROTOCOL_VERSIONS as readonly number[]).includes(protocol)
  ) {
    throw new HerdrProtocolMismatchError(protocol);
  }
}

export function isHerdrProtocolMismatch(error: unknown): boolean {
  return error instanceof HerdrProtocolMismatchError;
}
