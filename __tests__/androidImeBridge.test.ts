const {
  installAndroidImeBridge,
  terminalInputDelta,
} = require('../scripts/android-ime-bridge.cjs');

class FakeEventTarget {
  private listeners = new Map<string, EventListener>();

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  emit(type: string, event: Record<string, unknown>): void {
    this.listeners.get(type)?.(event as unknown as Event);
  }
}

function inputEvent(target: object, data: Record<string, unknown> = {}) {
  return {
    target,
    data: '',
    inputType: '',
    isComposing: false,
    keyCode: 0,
    stopPropagation: jest.fn(),
    preventDefault: jest.fn(),
    ...data,
  };
}

describe('Android terminal IME bridge', () => {
  test('converts autocomplete replacements into terminal edits', () => {
    expect(terminalInputDelta('', 'analuz')).toBe('analuz');
    expect(terminalInputDelta('analuz', 'analyze')).toBe('\u007f\u007fyze');
    expect(terminalInputDelta('noticed', 'notice')).toBe('\u007f');
    expect(terminalInputDelta('你', '你好')).toBe('好');
  });

  test('emits each composing textarea mutation once', () => {
    const target = new FakeEventTarget();
    const textarea = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      setAttribute: jest.fn(),
    };
    const sent: Array<{ type: string; data: string }> = [];
    installAndroidImeBridge(
      { textarea },
      (message: { type: string; data: string }) => sent.push(message),
      'Android',
      target,
    );

    target.emit('compositionstart', inputEvent(textarea));
    textarea.value = 'analuz';
    target.emit('compositionupdate', inputEvent(textarea, { data: 'analuz', isComposing: true }));
    target.emit('input', inputEvent(textarea, { data: 'analuz', isComposing: true }));
    textarea.value = 'analyze';
    target.emit('compositionupdate', inputEvent(textarea, { data: 'analyze', isComposing: true }));
    target.emit('input', inputEvent(textarea, { data: 'analyze', isComposing: true }));
    target.emit('compositionend', inputEvent(textarea, { data: 'analyze' }));
    target.emit('input', inputEvent(textarea, { data: 'analyze' }));

    expect(sent).toEqual([
      { type: 'input', data: 'analuz' },
      { type: 'input', data: '\u007f\u007fyze' },
    ]);
  });

  test('handles keyCode 229 input without allowing xterm to duplicate it', () => {
    const target = new FakeEventTarget();
    const textarea = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      setAttribute: jest.fn(),
    };
    const sent: Array<{ type: string; data: string }> = [];
    installAndroidImeBridge(
      { textarea },
      (message: { type: string; data: string }) => sent.push(message),
      'Android',
      target,
    );
    const keydown = inputEvent(textarea, { keyCode: 229 });
    const beforeInput = inputEvent(textarea, { inputType: 'insertText', data: 'x' });

    target.emit('keydown', keydown);
    target.emit('beforeinput', beforeInput);
    textarea.value = 'x';
    textarea.selectionStart = 1;
    textarea.selectionEnd = 1;
    target.emit('input', inputEvent(textarea, { inputType: 'insertText', data: 'x' }));

    expect(keydown.stopPropagation).toHaveBeenCalled();
    expect(beforeInput.stopPropagation).toHaveBeenCalled();
    expect(beforeInput.preventDefault).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: 'input', data: 'x' }]);
  });

  test.each(['insertReplacementText', 'insertText'])(
    'replaces Gboard-selected text reported as %s instead of appending',
    inputType => {
      const target = new FakeEventTarget();
      const textarea = {
        value: '',
        selectionStart: 0,
        selectionEnd: 0,
        setAttribute: jest.fn(),
      };
      const sent: Array<{ type: string; data: string }> = [];
      installAndroidImeBridge(
        { textarea },
        (message: { type: string; data: string }) => sent.push(message),
        'Android',
        target,
      );
      target.emit('keydown', inputEvent(textarea, { keyCode: 229 }));
      target.emit('beforeinput', inputEvent(textarea, { inputType: 'insertText', data: 'analuz' }));
      textarea.value = 'analuz';
      textarea.selectionStart = 6;
      textarea.selectionEnd = 6;
      target.emit('input', inputEvent(textarea, { inputType: 'insertText', data: 'analuz' }));

      textarea.selectionStart = 0;
      textarea.selectionEnd = 6;
      const replacement = inputEvent(textarea, {
        inputType,
        data: 'analyze',
      });

      target.emit('beforeinput', replacement);
      textarea.value = 'analyze';
      textarea.selectionStart = 7;
      textarea.selectionEnd = 7;
      target.emit('input', inputEvent(textarea, { inputType, data: 'analyze' }));

      expect(replacement.preventDefault).not.toHaveBeenCalled();
      expect(sent).toEqual([
        { type: 'input', data: 'analuz' },
        { type: 'input', data: '\u007f\u007fyze' },
      ]);
    },
  );

  test('reads the final textarea value after compositionend instead of trusting event data', () => {
    jest.useFakeTimers();
    const target = new FakeEventTarget();
    const textarea = {
      value: 'analuz',
      selectionStart: 6,
      selectionEnd: 6,
      setAttribute: jest.fn(),
    };
    const sent: Array<{ type: string; data: string }> = [];
    installAndroidImeBridge(
      { textarea },
      (message: { type: string; data: string }) => sent.push(message),
      'Android',
      target,
    );

    target.emit('compositionstart', inputEvent(textarea));
    target.emit('compositionend', inputEvent(textarea, { data: 'stale' }));
    textarea.value = 'analyze';
    jest.runOnlyPendingTimers();

    expect(sent).toEqual([{ type: 'input', data: '\u007f\u007fyze' }]);
    jest.useRealTimers();
  });

  test('emits Enter once even when Chrome applies the prevented textarea mutation', () => {
    const target = new FakeEventTarget();
    const textarea = {
      value: 'status',
      selectionStart: 6,
      selectionEnd: 6,
      setAttribute: jest.fn(),
    };
    const sent: Array<{ type: string; data: string }> = [];
    installAndroidImeBridge(
      { textarea },
      (message: { type: string; data: string }) => sent.push(message),
      'Android',
      target,
    );
    const beforeInput = inputEvent(textarea, { inputType: 'insertLineBreak' });

    target.emit('keydown', inputEvent(textarea, { keyCode: 229 }));
    target.emit('beforeinput', beforeInput);
    textarea.value = 'status\n';
    target.emit('input', inputEvent(textarea, { inputType: 'insertLineBreak', data: '\n' }));

    expect(beforeInput.preventDefault).toHaveBeenCalled();
    expect(sent).toEqual([{ type: 'input', data: '\r' }]);
    expect(textarea.value).toBe('');
  });

  test('leaves non-Android xterm input untouched', () => {
    const target = new FakeEventTarget();
    const textarea = { setAttribute: jest.fn() };
    const cleanup = installAndroidImeBridge(
      { textarea },
      jest.fn(),
      'iPhone',
      target,
    );

    expect(textarea.setAttribute).not.toHaveBeenCalled();
    expect(cleanup).toEqual(expect.any(Function));
  });
});
