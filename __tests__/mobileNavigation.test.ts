import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  handleMobileBack,
  initialMobileNavigation,
  selectMobileTab,
} from '../src/mobileNavigation';

test.each(['hosts', 'herd', 'more'] as const)(
  'terminal exit returns to herd after entering from %s',
  previousTab => {
    const previous = selectMobileTab(initialMobileNavigation, previousTab);
    const terminal = selectMobileTab(previous, 'terminal');
    expect(handleMobileBack(terminal).state.tab).toBe('herd');
  },
);

test('back returns non-host roots to hosts and leaves host root to Android', () => {
  const herd = selectMobileTab(initialMobileNavigation, 'herd');
  expect(handleMobileBack(herd).state.tab).toBe('hosts');
  expect(handleMobileBack(initialMobileNavigation).handled).toBe(false);
});

test('chat view leaves Android back gestures to app navigation', () => {
  const sessionScreen = readFileSync(
    join(__dirname, '..', 'src/components/SessionScreen.tsx'),
    'utf8',
  );

  expect(sessionScreen).not.toContain("BackHandler.addEventListener('hardwareBackPress'");
});
