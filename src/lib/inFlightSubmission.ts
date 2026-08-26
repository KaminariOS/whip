export interface InFlightGuard {
  current: boolean;
}

/** Synchronously reject re-entrant submissions before React state can render. */
export async function runWithInFlightGuard(
  guard: InFlightGuard,
  action: () => Promise<void>,
): Promise<boolean> {
  if (guard.current) return false;
  guard.current = true;
  try {
    await action();
    return true;
  } finally {
    guard.current = false;
  }
}
