/**
 * Converts a promise into an always-fulfilled serialization tail.
 *
 * Keep rejection swallowing confined to this utility. Callers should retain
 * and return the original promise when an observer still needs the failure.
 */
export async function settledPromise(
  promise: PromiseLike<unknown>,
): Promise<void> {
  try {
    await promise;
  } catch {
    // A settled serialization tail must not poison the next queued operation.
  }
}
