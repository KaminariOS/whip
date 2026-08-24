/** Wire protocols implemented by the bundled Android Herdr bridge codec. */
export const HERDR_PROTOCOL_VERSIONS = [17, 18, 19, 20] as const;
export const HERDR_PROTOCOL_VERSION = HERDR_PROTOCOL_VERSIONS.at(-1)!;
export const HERDR_PROTOCOL_VERSIONS_LABEL = `${HERDR_PROTOCOL_VERSIONS[0]}–${HERDR_PROTOCOL_VERSION}`;

export type HerdrTerminalAttachLaunchMode = 1 | 2;

/**
 * Herdr 0.8.2 inserted AppDirectGraphics before TerminalAttach in the
 * bincode enum while continuing to report protocol 20. Select the shifted
 * discriminant only for servers known to use that wire layout so protocol-20
 * releases through 0.8.0 remain attachable.
 */
export function herdrTerminalAttachLaunchMode(
  serverVersion: string | undefined,
): HerdrTerminalAttachLaunchMode {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(serverVersion?.trim() || '');
  if (!match) return 1;
  const version = match.slice(1).map(Number);
  const shiftedLayout = version[0] > 0
    || version[1] > 8
    || (version[1] === 8 && version[2] >= 2);
  return shiftedLayout ? 2 : 1;
}

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
): asserts protocol is number {
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
