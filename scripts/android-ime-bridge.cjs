function terminalInputDelta(previous, next) {
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) {
    common += 1;
  }
  return '\u007f'.repeat(before.length - common) + after.slice(common).join('');
}

// Android IMEs edit a composing buffer; translate those edits into terminal input
// before xterm can commit the same buffer a second time.
function installAndroidImeBridge(terminal, send, userAgent, eventTarget = window) {
  const input = terminal.textarea;
  if (!input || !/Android/i.test(userAgent)) return () => {};

  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');

  let composing = false;
  let preedit = '';
  let interceptInput = false;
  let suppressInput = false;
  let clearTimer = null;

  const isTerminalInput = event => event.target === input;
  const stopXterm = event => event.stopPropagation();
  const emit = data => {
    if (data) send({ type: 'input', data });
  };
  const emitPreedit = next => {
    const value = String(next || '');
    emit(terminalInputDelta(preedit, value));
    preedit = value;
  };
  const clearInput = () => {
    input.value = '';
    interceptInput = false;
  };

  const onCompositionStart = event => {
    if (!isTerminalInput(event)) return;
    stopXterm(event);
    composing = true;
    preedit = '';
    interceptInput = true;
    suppressInput = false;
  };
  const onCompositionUpdate = event => {
    if (!isTerminalInput(event)) return;
    stopXterm(event);
    emitPreedit(event.data || input.value);
  };
  const onCompositionEnd = event => {
    if (!isTerminalInput(event)) return;
    stopXterm(event);
    emitPreedit(event.data || preedit || input.value);
    composing = false;
    preedit = '';
    interceptInput = false;
    suppressInput = true;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      clearInput();
      suppressInput = false;
      clearTimer = null;
    }, 0);
  };
  const onKeyDown = event => {
    if (!isTerminalInput(event)) return;
    if (composing || event.isComposing || event.keyCode === 229) {
      interceptInput = true;
      stopXterm(event);
    }
  };
  const onBeforeInput = event => {
    if (!isTerminalInput(event)) return;
    if (composing || event.isComposing) {
      stopXterm(event);
      return;
    }
    const inputType = event.inputType || '';
    if (!interceptInput && inputType !== 'insertReplacementText') return;

    stopXterm(event);
    let data = '';
    if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
      data = '\r';
    } else if (inputType.startsWith('delete')) {
      data = inputType.includes('Forward') ? '\u001b[3~' : '\u007f';
    } else if (inputType === 'insertReplacementText') {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      data = '\u007f'.repeat(Math.max(0, end - start)) + (event.data || '');
    } else {
      data = event.data || event.dataTransfer?.getData('text/plain') || '';
    }

    if (!data) return;
    event.preventDefault();
    emit(data);
    suppressInput = true;
    clearInput();
  };
  const onInput = event => {
    if (!isTerminalInput(event)) return;
    if (composing || event.isComposing) {
      stopXterm(event);
      return;
    }
    if (!interceptInput && !suppressInput) return;

    stopXterm(event);
    if (!suppressInput) emit(event.data || input.value);
    suppressInput = false;
    clearInput();
  };

  const listeners = [
    ['compositionstart', onCompositionStart],
    ['compositionupdate', onCompositionUpdate],
    ['compositionend', onCompositionEnd],
    ['keydown', onKeyDown],
    ['beforeinput', onBeforeInput],
    ['input', onInput],
  ];
  for (const [type, listener] of listeners) eventTarget.addEventListener(type, listener, true);

  return () => {
    if (clearTimer) clearTimeout(clearTimer);
    for (const [type, listener] of listeners) eventTarget.removeEventListener(type, listener, true);
  };
}

module.exports = { installAndroidImeBridge, terminalInputDelta };
