import {
  cacheTierFromTokens,
  shouldNotifyCacheTransition,
  updateCacheTier,
  type CacheTier,
} from '../src/lib/cacheTtl';

describe('cacheTierFromTokens', () => {
  test('returns null tier when tokens is undefined', () => {
    expect(cacheTierFromTokens(undefined)).toEqual({ tier: null, label: null });
  });

  test('returns null tier when no cache tokens present', () => {
    expect(cacheTierFromTokens({ foo: 'bar' })).toEqual({ tier: null, label: null });
  });

  test('returns ok tier', () => {
    expect(cacheTierFromTokens({ cache_ok: '55m' })).toEqual({ tier: 'ok', label: '55m' });
  });

  test('returns warn tier', () => {
    expect(cacheTierFromTokens({ cache_warn: '8m' })).toEqual({ tier: 'warn', label: '8m' });
  });

  test('returns crit tier', () => {
    expect(cacheTierFromTokens({ cache_crit: '0m' })).toEqual({ tier: 'crit', label: '0m' });
  });

  test('crit takes precedence over warn and ok', () => {
    expect(cacheTierFromTokens({ cache_ok: '55m', cache_warn: '8m', cache_crit: '0m' }))
      .toEqual({ tier: 'crit', label: '0m' });
  });

  test('warn takes precedence over ok', () => {
    expect(cacheTierFromTokens({ cache_ok: '55m', cache_warn: '8m' }))
      .toEqual({ tier: 'warn', label: '8m' });
  });
});

describe('shouldNotifyCacheTransition', () => {
  test('does not notify when next is null', () => {
    expect(shouldNotifyCacheTransition('ok', null)).toBe(false);
  });

  test('does not notify for null → ok', () => {
    expect(shouldNotifyCacheTransition(null, 'ok')).toBe(false);
  });

  test('does not notify for ok → ok', () => {
    expect(shouldNotifyCacheTransition('ok', 'ok')).toBe(false);
  });

  test('notifies for null → warn', () => {
    expect(shouldNotifyCacheTransition(null, 'warn')).toBe(true);
  });

  test('notifies for null → crit', () => {
    expect(shouldNotifyCacheTransition(null, 'crit')).toBe(true);
  });

  test('notifies for ok → warn', () => {
    expect(shouldNotifyCacheTransition('ok', 'warn')).toBe(true);
  });

  test('notifies for ok → crit', () => {
    expect(shouldNotifyCacheTransition('ok', 'crit')).toBe(true);
  });

  test('notifies for warn → crit', () => {
    expect(shouldNotifyCacheTransition('warn', 'crit')).toBe(true);
  });

  test('does not notify for crit → warn (downgrade)', () => {
    expect(shouldNotifyCacheTransition('crit', 'warn')).toBe(false);
  });

  test('does not notify for warn → ok (downgrade)', () => {
    expect(shouldNotifyCacheTransition('warn', 'ok')).toBe(false);
  });

  test('does not notify for crit → crit (steady)', () => {
    expect(shouldNotifyCacheTransition('crit', 'crit')).toBe(false);
  });
});

describe('updateCacheTier', () => {
  test('sets tier in map and returns shouldNotify false for ok', () => {
    const map = new Map<string, CacheTier>();
    const result = updateCacheTier(map, 'p1', { cache_ok: '55m' });
    expect(result).toEqual({ tier: 'ok', shouldNotify: false });
    expect(map.get('p1')).toBe('ok');
  });

  test('escalation from ok to warn notifies and updates map', () => {
    const map = new Map<string, CacheTier>([['p1', 'ok']]);
    const result = updateCacheTier(map, 'p1', { cache_warn: '8m' });
    expect(result).toEqual({ tier: 'warn', shouldNotify: true });
    expect(map.get('p1')).toBe('warn');
  });

  test('deletes pane from map when tokens have no cache tier', () => {
    const map = new Map<string, CacheTier>([['p1', 'ok']]);
    const result = updateCacheTier(map, 'p1', { unrelated: 'token' });
    expect(result).toEqual({ tier: null, shouldNotify: false });
    expect(map.has('p1')).toBe(false);
  });

  test('deletes pane from map when tokens is undefined', () => {
    const map = new Map<string, CacheTier>([['p1', 'warn']]);
    const result = updateCacheTier(map, 'p1', undefined);
    expect(result).toEqual({ tier: null, shouldNotify: false });
    expect(map.has('p1')).toBe(false);
  });

  test('re-enabled alerts after disable do not false-notify', () => {
    const map = new Map<string, CacheTier>([['p1', 'ok']]);
    const result = updateCacheTier(map, 'p1', { cache_ok: '50m' });
    expect(result.shouldNotify).toBe(false);
    expect(map.get('p1')).toBe('ok');
  });
});
