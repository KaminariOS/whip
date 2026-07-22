import {
  handleMobileBack,
  initialMobileNavigation,
  selectMobileTab,
} from '../src/mobileNavigation';

test('terminal exit returns to the last non-terminal destination', () => {
  const herd = selectMobileTab(initialMobileNavigation, 'herd');
  const terminal = selectMobileTab(herd, 'terminal');
  expect(handleMobileBack(terminal)).toEqual({ handled: true, state: herd });
});

test('back returns non-host roots to hosts and leaves host root to Android', () => {
  const herd = selectMobileTab(initialMobileNavigation, 'herd');
  expect(handleMobileBack(herd).state.tab).toBe('hosts');
  expect(handleMobileBack(initialMobileNavigation).handled).toBe(false);
});
