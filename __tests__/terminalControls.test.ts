import {
  defaultTerminalControlOrder,
  incrementTerminalControlUsage,
  orderTerminalControls,
  parseTerminalControlUsage,
  TERMINAL_CONTROL_HIT_SLOP,
  TERMINAL_ICON_CONTROL_CLASS,
  TERMINAL_TEXT_CONTROL_CLASS,
} from '../src/lib/terminalControls';

test('terminal controls use compact faces with 44pt native touch height', () => {
  const iconClasses = TERMINAL_ICON_CONTROL_CLASS.split(/\s+/);
  const textClasses = TERMINAL_TEXT_CONTROL_CLASS.split(/\s+/);

  expect(iconClasses).toEqual(
    expect.arrayContaining(['h-9', 'min-h-0', 'w-11']),
  );
  expect(textClasses).toEqual(
    expect.arrayContaining(['h-9', 'min-h-0', 'min-w-11']),
  );
  expect(TERMINAL_CONTROL_HIT_SLOP).toEqual({ top: 4, bottom: 4 });
});

test('starts with common controls and keeps secondary navigation at the right end', () => {
  expect(defaultTerminalControlOrder.slice(0, 15)).toEqual([
    'keyboard', 'ctrl', 'shift', 'esc', 'tab', 'paste', 'history', 'compose',
    'chat', 'attach', 'files', 'links', 'up', 'left', 'right',
  ]);
  expect(defaultTerminalControlOrder.slice(-4)).toEqual(['page-down', 'alt', 'find', 'home']);
  expect(defaultTerminalControlOrder).not.toContain('ctrl-c');
  expect(defaultTerminalControlOrder).not.toContain('hyphen');
  expect(defaultTerminalControlOrder).not.toContain('shift-tab');
});

test('orders frequently used terminal controls first and keeps stable ties', () => {
  const order = orderTerminalControls({ paste: 8, home: 3, ctrl: 8 });

  expect(order.slice(0, 3)).toEqual(['ctrl', 'paste', 'home']);
  expect(order.indexOf('esc')).toBeLessThan(order.indexOf('tab'));
});

test('increments one persisted control without losing other usage', () => {
  expect(incrementTerminalControlUsage({ ctrl: 2 }, 'paste')).toEqual({ ctrl: 2, paste: 1 });
});

test('accepts only known positive finite usage counters', () => {
  expect(parseTerminalControlUsage({ ctrl: 2.4, home: Infinity, unknown: 10, tab: 0 }))
    .toEqual({ ctrl: 2 });
});
