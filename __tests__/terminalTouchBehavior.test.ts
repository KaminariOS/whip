import { Terminal } from '@xterm/xterm';

const {
  forcedTerminalMouseInputSequence,
  handleKeyboardClosedStationaryTap,
  setTerminalKeyboardInputEnabled,
} = require('../scripts/terminal-touch-behavior.cjs') as {
  forcedTerminalMouseInputSequence: (enabled: boolean) => string;
  handleKeyboardClosedStationaryTap: (options: {
    point: { clientX: number; clientY: number };
    urlAtPoint: (x: number, y: number) => string | null;
    terminalMouseCaptured: () => boolean;
    dispatchTerminalClick: (point: { clientX: number; clientY: number }) => boolean;
    send: (message: { type: string; link?: string }) => void;
    clearInteractiveSelection: (clearNativeSelection: boolean) => void;
  }) => void;
  setTerminalKeyboardInputEnabled: (
    terminal: {
      textarea: { readOnly: boolean; inputMode: string };
      blur: () => void;
    },
    enabled: boolean,
  ) => boolean;
};

const point = { clientX: 44, clientY: 40 };

function tapHarness(mouseTrackingMode: string, link: string | null = null) {
  const terminal = { modes: { mouseTrackingMode } };
  const messages: Array<{ type: string; link?: string }> = [];
  const dispatchTerminalClick = jest.fn(() => true);
  const clearInteractiveSelection = jest.fn();

  handleKeyboardClosedStationaryTap({
    point,
    urlAtPoint: () => link,
    terminalMouseCaptured: () => terminal.modes.mouseTrackingMode !== 'none',
    dispatchTerminalClick,
    send: message => messages.push(message),
    clearInteractiveSelection,
  });

  return { messages, dispatchTerminalClick, clearInteractiveSelection };
}

test('keyboard-closed stationary tap emits no input when xterm mouse tracking is disabled', () => {
  const result = tapHarness('none');

  expect(result.messages).toEqual([]);
  expect(result.dispatchTerminalClick).not.toHaveBeenCalled();
  expect(result.clearInteractiveSelection).toHaveBeenCalledWith(true);
});

test('keyboard-closed stationary tap delegates to xterm when mouse tracking is enabled', () => {
  const result = tapHarness('vt200');

  expect(result.messages).toEqual([]);
  expect(result.dispatchTerminalClick).toHaveBeenCalledWith(point);
  expect(result.clearInteractiveSelection).not.toHaveBeenCalled();
});

test('keyboard-closed stationary tap opens a link before considering mouse tracking', () => {
  const result = tapHarness('vt200', 'https://example.com/');

  expect(result.messages).toEqual([{
    type: 'open-link',
    link: 'https://example.com/',
  }]);
  expect(result.dispatchTerminalClick).not.toHaveBeenCalled();
});

test('forced TUI tapping changes xterm mouse capture without encoding clicks outside xterm', async () => {
  const terminal = new Terminal();
  const write = (data: string) => new Promise<void>(resolve => {
    terminal.write(data, resolve);
  });

  expect(terminal.modes.mouseTrackingMode).toBe('none');

  await write(forcedTerminalMouseInputSequence(true));
  expect(terminal.modes.mouseTrackingMode).toBe('vt200');

  const result = tapHarness(terminal.modes.mouseTrackingMode);
  expect(result.dispatchTerminalClick).toHaveBeenCalledWith(point);
  expect(result.messages).toEqual([]);

  await write(forcedTerminalMouseInputSequence(false));
  expect(terminal.modes.mouseTrackingMode).toBe('none');
  terminal.dispose();
});

test('keyboard-disabled xterm remains focusable for mouse handling without opening the IME', () => {
  const terminal = {
    textarea: { readOnly: false, inputMode: '' },
    blur: jest.fn(),
  };

  expect(setTerminalKeyboardInputEnabled(terminal, false)).toBe(false);
  expect(terminal.textarea).toEqual({ readOnly: true, inputMode: 'none' });
  expect(terminal.blur).toHaveBeenCalledTimes(1);

  expect(setTerminalKeyboardInputEnabled(terminal, true)).toBe(true);
  expect(terminal.textarea).toEqual({ readOnly: false, inputMode: '' });
});
