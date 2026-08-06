import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HERD_TAB_CLOSE_DISTANCE,
  HERD_TAB_MAX_DRAG,
  herdTabSwipeOffset,
  shouldClaimHerdTabSwipe,
  shouldCloseHerdTabSwipe,
} from '../src/lib/herdTabSwipeActions';

describe('Herd tab swipe actions', () => {
  it('claims only deliberate leftward horizontal movement', () => {
    expect(shouldClaimHerdTabSwipe(-20, 2)).toBe(true);
    expect(shouldClaimHerdTabSwipe(20, 2)).toBe(false);
    expect(shouldClaimHerdTabSwipe(-20, 19)).toBe(false);
    expect(shouldClaimHerdTabSwipe(-8, 0)).toBe(false);
  });

  it('follows leftward movement within a bounded reveal', () => {
    expect(herdTabSwipeOffset(-40)).toBe(-40);
    expect(herdTabSwipeOffset(-300)).toBe(-HERD_TAB_MAX_DRAG);
    expect(herdTabSwipeOffset(40)).toBe(0);
  });

  it('closes after enough distance or a deliberate left fling', () => {
    expect(shouldCloseHerdTabSwipe(-HERD_TAB_CLOSE_DISTANCE, 0)).toBe(true);
    expect(shouldCloseHerdTabSwipe(-HERD_TAB_CLOSE_DISTANCE + 1, 0)).toBe(false);
    expect(shouldCloseHerdTabSwipe(-30, -0.8)).toBe(true);
    expect(shouldCloseHerdTabSwipe(-20, -0.8)).toBe(false);
    expect(shouldCloseHerdTabSwipe(20, -0.8)).toBe(false);
  });

  it('wires the direct close gesture to the Herdr tab API', () => {
    const screen = readFileSync(resolve(__dirname, '../src/components/HerdScreen.tsx'), 'utf8');
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(screen).toContain('onCloseTab(item.hostId, item.agent.tab_id)');
    expect(screen).toContain('shouldCloseHerdTabSwipe(gesture.dx, gesture.vx)');
    expect(screen).toMatch(/const visibleSorted = useMemo\([\s\S]*?sorted\.filter\(/);
    expect(screen).toContain('data={selectedQueue && !selectedQueue.running ? [] : visibleSorted}');
    expect(screen).toContain('renderItem={renderAgent}');
    expect(screen).toMatch(/translateX\.value = withTiming\(\s*-Math\.max\(rowWidthRef\.current, HERD_TAB_MAX_DRAG\)/);
    expect(screen).toMatch(/rowHeight\.value = withDelay\(\s*50,\s*withTiming\(\s*0/);
    expect(screen).toContain('scheduleOnRN(finishClose, Boolean(finished))');
    expect(screen).toMatch(/<Icon\s+as=\{X\}\s+className="text-destructive-foreground"\s+size=\{22\}\s*\/>/);
    expect(screen).not.toContain('text-destructive-foreground">{t(\'common.close\')}');
    expect(screen).not.toContain('variant="destructive"');
    expect(app).toContain('await runtime.client.closeTab(tabId);');
    expect(app).toContain('onCloseTab={closeHerdTab}');
  });
});
