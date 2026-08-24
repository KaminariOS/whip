import {
  serverFocusMatchesPendingPane,
  shouldFollowServerTerminalFocus,
} from '../src/lib/terminalFocus';

test('ignores stale server focus while a selected pane is pending', () => {
  expect(serverFocusMatchesPendingPane('previous-pane', 'selected-pane')).toBe(false);
  expect(serverFocusMatchesPendingPane('selected-pane', 'selected-pane')).toBe(true);
});

test('follows server focus when there is no pending user selection', () => {
  expect(serverFocusMatchesPendingPane('remote-pane', null)).toBe(true);
});

test('does not let startup focus updates steal an already visible terminal tab', () => {
  expect(shouldFollowServerTerminalFocus(true, 'selected-pane')).toBe(false);
  expect(shouldFollowServerTerminalFocus(false, 'selected-pane')).toBe(true);
  expect(shouldFollowServerTerminalFocus(true, null)).toBe(true);
});
