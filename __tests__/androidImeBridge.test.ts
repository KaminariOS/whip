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

  test('emits each composing update once and does not resend the final text', () => {
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
    target.emit('compositionupdate', inputEvent(textarea, { data: 'analuz', isComposing: true }));
    target.emit('compositionupdate', inputEvent(textarea, { data: 'analyze', isComposing: true }));
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
      value: 'x',
      selectionStart: 1,
      selectionEnd: 1,
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

    expect(keydown.stopPropagation).toHaveBeenCalled();
    expect(beforeInput.stopPropagation).toHaveBeenCalled();
    expect(beforeInput.preventDefault).toHaveBeenCalled();
    expect(sent).toEqual([{ type: 'input', data: 'x' }]);
  });

  test('replaces Gboard-selected text instead of appending the suggestion', () => {
    const target = new FakeEventTarget();
    const textarea = {
      value: 'analuz',
      selectionStart: 0,
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
    const replacement = inputEvent(textarea, {
      inputType: 'insertReplacementText',
      data: 'analyze',
    });

    target.emit('beforeinput', replacement);

    expect(replacement.preventDefault).toHaveBeenCalled();
    expect(sent).toEqual([{
      type: 'input',
      data: '\u007f\u007f\u007f\u007f\u007f\u007fanalyze',
    }]);
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
