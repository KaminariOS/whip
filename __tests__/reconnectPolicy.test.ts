import {
  defaultReconnectPolicy,
  nextReconnect,
  reconnectDelay,
  shouldRestartReconnect,
} from '../src/lib/reconnectPolicy';

test('uses bounded exponential delays for the default reconnect sequence', () => {
  expect([1, 2, 3, 4, 5].map(attempt => reconnectDelay(attempt))).toEqual([
    750,
    1500,
    3000,
    6000,
    8000,
  ]);
});

test('stops after the configured number of attempts', () => {
  expect(nextReconnect(0)).toEqual({ action: 'retry', attempt: 1, delayMs: 750 });
  expect(nextReconnect(4)).toEqual({ action: 'retry', attempt: 5, delayMs: 8000 });
  expect(nextReconnect(5)).toEqual({ action: 'stop', attempts: 5 });
});

test('supports a custom reconnect policy', () => {
  const policy = { maxAttempts: 2, initialDelayMs: 100, multiplier: 3, maxDelayMs: 250 };
  expect(nextReconnect(0, policy)).toEqual({ action: 'retry', attempt: 1, delayMs: 100 });
  expect(nextReconnect(1, policy)).toEqual({ action: 'retry', attempt: 2, delayMs: 250 });
  expect(nextReconnect(2, policy)).toEqual({ action: 'stop', attempts: 2 });
});

test('restarts exhausted retries on resume and every transport after a network change', () => {
  expect(shouldRestartReconnect(4, 'app-resume')).toBe(false);
  expect(shouldRestartReconnect(5, 'app-resume')).toBe(true);
  expect(shouldRestartReconnect(0, 'network-change')).toBe(true);
});

test('rejects invalid attempts and policies', () => {
  expect(() => reconnectDelay(0)).toThrow('attempt must be a positive integer');
  expect(() => nextReconnect(-1)).toThrow('completedAttempts must be a non-negative integer');
  expect(() => nextReconnect(0, { ...defaultReconnectPolicy, multiplier: 0.5 })).toThrow(
    'multiplier must be a finite number greater than or equal to 1',
  );
});
