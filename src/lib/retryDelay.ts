const INITIAL_RETRY_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 8000;

/** Equal-jitter backoff for UI-owned queues; host reconnect policy lives in Rust. */
export function retryDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const upperBound = Math.min(
    MAX_RETRY_DELAY_MS,
    INITIAL_RETRY_DELAY_MS * (2 ** (attempt - 1)),
  );
  return Math.round(upperBound * (0.5 + random() * 0.5));
}
