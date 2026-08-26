import { retryDelay } from '../src/lib/retryDelay';

test('uses capped equal-jitter backoff for UI-owned retry queues', () => {
  expect([1, 2, 3, 4, 5].map(attempt => retryDelay(attempt, () => 1))).toEqual([
    750,
    1500,
    3000,
    6000,
    8000,
  ]);
  expect(retryDelay(1, () => 0)).toBe(375);
  expect(retryDelay(1, () => 0.5)).toBe(563);
  expect(retryDelay(5, () => 0)).toBe(4000);
});
