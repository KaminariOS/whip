import {
  handleMobileBack,
  initialMobileNavigation,
  pushMobileScreen,
  selectMobileTab,
} from '../src/mobileNavigation';

test('terminal exit returns to the last non-terminal destination', () => {
  const herd = selectMobileTab(initialMobileNavigation, 'herd');
  const terminal = selectMobileTab(herd, 'terminal');
  expect(handleMobileBack(terminal)).toEqual({ handled: true, state: herd });
});

test('back pops pushed screens before changing tabs', () => {
  const more = selectMobileTab(initialMobileNavigation, 'more');
  const settings = pushMobileScreen(more, 'settings');
  expect(handleMobileBack(settings)).toEqual({ handled: true, state: more });

  const about = pushMobileScreen(more, 'about');
  expect(handleMobileBack(about)).toEqual({ handled: true, state: more });
});

test('back returns non-host roots to hosts and leaves host root to Android', () => {
  const herd = selectMobileTab(initialMobileNavigation, 'herd');
  expect(handleMobileBack(herd).state.tab).toBe('hosts');
  expect(handleMobileBack(initialMobileNavigation).handled).toBe(false);
});
