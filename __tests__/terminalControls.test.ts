import {
  defaultTerminalControlOrder,
  incrementTerminalControlUsage,
  orderTerminalControls,
  parseTerminalControlUsage,
} from '../src/lib/terminalControls';

test('starts with common controls and keeps secondary navigation at the right end', () => {
  expect(defaultTerminalControlOrder.slice(0, 9)).toEqual([
    'ctrl', 'esc', 'tab', 'paste', 'compose', 'up', 'left', 'right', 'down',
  ]);
  expect(defaultTerminalControlOrder.slice(-4)).toEqual(['alt', 'find', 'shift-tab', 'home']);
  expect(defaultTerminalControlOrder).not.toContain('ctrl-c');
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
