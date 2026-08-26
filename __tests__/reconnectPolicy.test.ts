import {
  MAX_RECONNECT_ATTEMPTS,
  nextReconnect,
  reconnectDelay,
  shouldRestartReconnect,
} from '../src/lib/reconnectPolicy';

test('uses bounded exponential windows for the reconnect sequence', () => {
  expect([1, 2, 3, 4, 5].map(attempt => reconnectDelay(attempt, () => 1))).toEqual([
    750,
    1500,
    3000,
    6000,
    8000,
  ]);
});

test('spreads retries across the latter half of each backoff window', () => {
  expect(reconnectDelay(1, () => 0)).toBe(375);
  expect(reconnectDelay(1, () => 0.5)).toBe(563);
  expect(reconnectDelay(5, () => 0)).toBe(4000);
  expect(reconnectDelay(5, () => 1)).toBe(8000);
});

test('stops after the configured number of attempts', () => {
  expect(nextReconnect(0, () => 1)).toEqual({ action: 'retry', attempt: 1, delayMs: 750 });
  expect(nextReconnect(4, () => 1)).toEqual({ action: 'retry', attempt: 5, delayMs: 8000 });
  expect(nextReconnect(5)).toEqual({ action: 'stop', attempts: 5 });
});

test('restarts exhausted retries on resume and every transport after a network change', () => {
  expect(shouldRestartReconnect(MAX_RECONNECT_ATTEMPTS - 1, 'app-resume')).toBe(false);
  expect(shouldRestartReconnect(MAX_RECONNECT_ATTEMPTS, 'app-resume')).toBe(true);
  expect(shouldRestartReconnect(0, 'network-change')).toBe(true);
});
