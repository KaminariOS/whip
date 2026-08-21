export type NetworkDiagnosticLevel = 'info' | 'warn' | 'error';

type NetworkDiagnosticValue = string | number | boolean | null | undefined;

const MAX_ERROR_CHARACTERS = 1_000;

export function networkErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message || error.name : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARACTERS);
}

export function recordNetworkDiagnostic(
  level: NetworkDiagnosticLevel,
  event: string,
  details: Readonly<Record<string, NetworkDiagnosticValue>> = {},
): void {
  const populatedDetails = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
  const suffix =
    Object.keys(populatedDetails).length > 0
      ? ` ${JSON.stringify(populatedDetails)}`
      : '';
  console[level](`[NetworkDiagnostics] ${event}${suffix}`);
}
