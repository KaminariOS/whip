import {
  handleMobileBack,
  initialMobileNavigation,
  selectMobileTab,
} from '../src/mobileNavigation';

test('terminal exit returns to the last non-terminal destination', () => {
  const more = selectMobileTab(initialMobileNavigation, 'more');
  const terminal = selectMobileTab(more, 'terminal');
  expect(handleMobileBack(terminal)).toEqual({ handled: true, state: more });
});

test('back returns non-host roots to hosts and leaves host root to Android', () => {
  const more = selectMobileTab(initialMobileNavigation, 'more');
  expect(handleMobileBack(more).state.tab).toBe('hosts');
  expect(handleMobileBack(initialMobileNavigation).handled).toBe(false);
});
