export type OperationalDiagnosticLevel = 'warn' | 'error';

export type OperationalDiagnosticSubsystem =
  | 'Credential'
  | 'GlobalSshKeychain'
  | 'Notification'
  | 'Security'
  | 'RevenueCat'
  | 'Application';

export type OperationalDiagnosticValue =
  | string
  | number
  | boolean
  | null
  | undefined;

const MAX_ERROR_CHARACTERS = 1_000;

export function operationalErrorDetails(
  error: unknown,
): Readonly<Record<string, OperationalDiagnosticValue>> {
  const candidate = error && typeof error === 'object'
    ? error as { name?: unknown; code?: unknown; message?: unknown }
    : null;
  let message = 'Unknown operational error';
  try {
    message = error instanceof Error
      ? error.message || error.name
      : typeof candidate?.message === 'string'
        ? candidate.message
        : String(error);
  } catch {
    // Some native error objects throw while being coerced to strings.
  }
  return {
    error: message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARACTERS),
    errorName: typeof candidate?.name === 'string' ? candidate.name : undefined,
    errorCode:
      typeof candidate?.code === 'string' || typeof candidate?.code === 'number'
        ? candidate.code
        : undefined,
  };
}

export function operationalParseErrorDetails(
  error: unknown,
): Readonly<Record<string, OperationalDiagnosticValue>> {
  const details = operationalErrorDetails(error);
  return {
    error: 'Structured data could not be parsed or validated',
    errorName: details.errorName,
    errorCode: details.errorCode,
  };
}

export function recordOperationalDiagnostic(
  level: OperationalDiagnosticLevel,
  subsystem: OperationalDiagnosticSubsystem,
  event: string,
  details: Readonly<Record<string, OperationalDiagnosticValue>> = {},
): void {
  const populatedDetails = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
  const suffix = Object.keys(populatedDetails).length > 0
    ? ` ${JSON.stringify(populatedDetails)}`
    : '';
  console[level](`[${subsystem}Diagnostics] ${event}${suffix}`);
}
