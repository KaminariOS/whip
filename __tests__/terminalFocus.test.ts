import { serverFocusMatchesPendingPane } from '../src/lib/terminalFocus';

test('ignores stale server focus while a selected pane is pending', () => {
  expect(serverFocusMatchesPendingPane('previous-pane', 'selected-pane')).toBe(false);
  expect(serverFocusMatchesPendingPane('selected-pane', 'selected-pane')).toBe(true);
});

test('follows server focus when there is no pending user selection', () => {
  expect(serverFocusMatchesPendingPane('remote-pane', null)).toBe(true);
});
