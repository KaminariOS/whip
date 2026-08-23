import {
  directTerminalKeyboardEnabled,
  isOfflineTerminalNavigationInput,
  terminalScrollbackMode,
} from '../src/lib/terminalRenderer';

describe('isOfflineTerminalNavigationInput', () => {
  it.each(['\u001b[A', '\u001b[B', '\u001b[5~', '\u001b[6~', '\u001b[H', '\u001b[F'])(
    'accepts read-only navigation input %j',
    input => expect(isOfflineTerminalNavigationInput(input)).toBe(true),
  );

  it.each(['a', '\r', '\t', '\u001b[C'])(
    'rejects pane-mutating input %j',
    input => expect(isOfflineTerminalNavigationInput(input)).toBe(false),
  );
});

describe('terminalScrollbackMode', () => {
  it('uses remote scrollback for a connected Herdr terminal', () => {
    expect(terminalScrollbackMode({ kind: 'herdr', status: 'connected' })).toEqual({
      localScrollback: false,
      offlineScrollback: false,
    });
  });

  it.each(['connecting', 'disconnected', 'error'] as const)(
    'forces cached local scrollback while %s',
    status => {
      expect(terminalScrollbackMode({ kind: 'herdr', status })).toEqual({
        localScrollback: false,
        offlineScrollback: true,
      });
    },
  );

  it('preserves SSH local scrollback while connected', () => {
    expect(terminalScrollbackMode({ kind: 'ssh', status: 'connected' })).toEqual({
      localScrollback: true,
      offlineScrollback: false,
    });
  });
});

describe('directTerminalKeyboardEnabled', () => {
  it('enables direct input only for a connected terminal without the composer', () => {
    expect(directTerminalKeyboardEnabled('connected', true, false)).toBe(true);
    expect(directTerminalKeyboardEnabled('connected', false, false)).toBe(false);
    expect(directTerminalKeyboardEnabled('connected', true, true)).toBe(false);
  });

  it.each(['connecting', 'disconnected', 'error'] as const)(
    'disables direct input while %s',
    status => expect(directTerminalKeyboardEnabled(status, true, false)).toBe(false),
  );
});
