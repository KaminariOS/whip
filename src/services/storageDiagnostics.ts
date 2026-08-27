export type StorageDiagnosticLevel = 'warn' | 'error';

export type StorageDiagnosticEvent =
  | 'startup-storage-multiget-failed'
  | 'storage-read-failed'
  | 'storage-parse-failed'
  | 'storage-write-failed'
  | 'storage-remove-failed';

type StorageDiagnosticValue = string | number | boolean | null | undefined;

const MAX_ERROR_CHARACTERS = 1_000;

export function storageErrorMessage(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message || error.name : String(error);
  } catch {
    message = 'Unknown storage error';
  }
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARACTERS);
}

export function storageErrorDetails(error: unknown): Readonly<Record<string, StorageDiagnosticValue>> {
  const candidate = error && typeof error === 'object'
    ? error as { name?: unknown; code?: unknown }
    : null;
  const errorName = candidate && typeof candidate.name === 'string'
    ? candidate.name
    : undefined;
  const errorCode = candidate
    && (typeof candidate.code === 'string' || typeof candidate.code === 'number')
    ? candidate.code
    : undefined;
  return {
    error: storageErrorMessage(error),
    errorName,
    errorCode,
  };
}

export function storageParseErrorDetails(error: unknown): Readonly<Record<string, StorageDiagnosticValue>> {
  const details = storageErrorDetails(error);
  return {
    error: 'Stored JSON could not be parsed or validated',
    errorName: details.errorName,
    errorCode: details.errorCode,
  };
}

export function recordStorageDiagnostic(
  level: StorageDiagnosticLevel,
  event: StorageDiagnosticEvent,
  details: Readonly<Record<string, StorageDiagnosticValue>> = {},
): void {
  const populatedDetails = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
  const suffix = Object.keys(populatedDetails).length > 0
    ? ` ${JSON.stringify(populatedDetails)}`
    : '';
  console[level](`[StorageDiagnostics] ${event}${suffix}`);
}
