import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HOST_SWIPE_ACTION_WIDTH,
  hostSwipeOffset,
  shouldClaimHostSwipe,
  shouldOpenHostSwipe,
} from '../src/lib/hostSwipeActions';

describe('host swipe actions', () => {
  it('claims only a deliberate drag toward the available actions', () => {
    expect(shouldClaimHostSwipe(-20, 2, false)).toBe(true);
    expect(shouldClaimHostSwipe(20, 2, false)).toBe(false);
    expect(shouldClaimHostSwipe(20, 2, true)).toBe(true);
    expect(shouldClaimHostSwipe(-20, 2, true)).toBe(false);
    expect(shouldClaimHostSwipe(-20, 19, false)).toBe(false);
    expect(shouldClaimHostSwipe(-8, 0, false)).toBe(false);
  });

  it('clamps the host card between closed and fully exposed', () => {
    expect(hostSwipeOffset(-40, false)).toBe(-40);
    expect(hostSwipeOffset(-300, false)).toBe(-HOST_SWIPE_ACTION_WIDTH);
    expect(hostSwipeOffset(40, false)).toBe(0);
    expect(hostSwipeOffset(40, true)).toBe(-HOST_SWIPE_ACTION_WIDTH + 40);
    expect(hostSwipeOffset(300, true)).toBe(0);
  });

  it('settles using distance or swipe velocity', () => {
    expect(shouldOpenHostSwipe(-HOST_SWIPE_ACTION_WIDTH * 0.6, 0, false)).toBe(true);
    expect(shouldOpenHostSwipe(-20, -0.5, false)).toBe(true);
    expect(shouldOpenHostSwipe(20, 0.5, true)).toBe(false);
    expect(shouldOpenHostSwipe(20, 0, true)).toBe(true);
    expect(shouldOpenHostSwipe(HOST_SWIPE_ACTION_WIDTH, 0, true)).toBe(false);
  });

  it('exposes disconnect and delete actions wired to the app flows', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/HostsScreen.tsx'),
      'utf8',
    );
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(screen).toContain("t('hosts.disconnectHost'");
    expect(screen).toContain("t('hosts.deleteHost'");
    expect(screen).toContain('disabled={!connected}');
    expect(app).toContain('onDelete={confirmDeleteHost}');
    expect(app).toContain('if (live) closeLiveHost(live.id)');
  });
});
