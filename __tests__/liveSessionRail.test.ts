import { liveSessionRailIndicator } from '../src/lib/liveSessionRail';

describe('Herd live-session rail connection indicators', () => {
  test.each(['connected', 'ready'] as const)(
    'keeps the agent glyph while a host is %s',
    status => {
      expect(liveSessionRailIndicator(status)).toBe('agent');
    },
  );

  test.each(['connecting', 'reconnecting'] as const)(
    'shows animated progress while a host is %s',
    status => {
      expect(liveSessionRailIndicator(status)).toBe('progress');
    },
  );

  test.each(['disconnected', 'error'] as const)(
    'shows the offline icon while a host is %s',
    status => {
      expect(liveSessionRailIndicator(status)).toBe('offline');
    },
  );
});
