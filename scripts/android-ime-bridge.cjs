function terminalInputDelta(previous, next) {
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) {
    common += 1;
  }
  return '\u007f'.repeat(before.length - common) + after.slice(common).join('');
}

// Android IMEs edit a composing buffer; mirror that buffer and translate each
// mutation into terminal input before xterm can commit it a second time.
function installAndroidImeBridge(terminal, send, userAgent, eventTarget = window) {
  const input = terminal.textarea;
  if (!input || !/Android/i.test(userAgent)) return () => {};

  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');

  let composing = false;
  let interceptInput = false;
  let suppressInput = false;
  let mirroredValue = String(input.value || '');
  let reconcileTimer = null;

  const isTerminalInput = event => event.target === input;
  const stopXterm = event => event.stopPropagation();
  const emit = data => {
    if (data) send({ type: 'input', data });
  };
  const reconcileInput = () => {
    const next = String(input.value || '');
    emit(terminalInputDelta(mirroredValue, next));
    mirroredValue = next;
  };
  const cancelReconcile = () => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
  };
  const flushReconcile = () => {
    cancelReconcile();
    reconcileInput();
  };
  const scheduleReconcile = () => {
    cancelReconcile();
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      reconcileInput();
    }, 0);
  };
  const resetInput = () => {
    cancelReconcile();
    input.value = '';
    mirroredValue = '';
    interceptInput = false;
    suppressInput = false;
  };
  const scheduleReset = () => {
    cancelReconcile();
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      input.value = '';
      mirroredValue = '';
      interceptInput = false;
      suppressInput = false;
    }, 0);
  };

  const onCompositionStart = event => {
    if (!isTerminalInput(event)) return;
    stopXterm(event);
    composing = true;
    interceptInput = true;
    scheduleReconcile();
  };
  const onCompositionUpdate = event => {
    if (!isTerminalInput(event)) return;
    stopXterm(event);
    scheduleReconcile();
  };
  const onCompositionEnd = event => {
    if (!isTerminalInput(event)) return;
    stopXterm(event);
    composing = false;
    // Chromium may mutate the textarea after compositionend, and event.data is
    // not reliable for every IME. Read the resulting value on the next task.
    scheduleReconcile();
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
    const start = typeof input.selectionStart === 'number' ? input.selectionStart : 0;
    const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
    const replacesSelection = end > start;
    if (!interceptInput && inputType !== 'insertReplacementText' && !replacesSelection) return;

    stopXterm(event);
    if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
      event.preventDefault();
      emit('\r');
      suppressInput = true;
      scheduleReset();
      return;
    }
    if (inputType === 'deleteContentForward' && start === end) {
      event.preventDefault();
      emit('\u001b[3~');
      return;
    }

    // Let the IME update its editable buffer. On Chrome Android,
    // preventDefault() on beforeinput is not consistently honored anyway.
    // The input event normally reconciles synchronously; this timer covers IMEs
    // that mutate the textarea without delivering a usable input event.
    interceptInput = true;
    scheduleReconcile();
  };
  const onInput = event => {
    if (!isTerminalInput(event)) return;
    if (suppressInput) {
      stopXterm(event);
      resetInput();
      return;
    }
    if (composing || event.isComposing) {
      stopXterm(event);
      flushReconcile();
      return;
    }
    if (!interceptInput) return;

    stopXterm(event);
    flushReconcile();
  };
  const onBlur = event => {
    if (!isTerminalInput(event)) return;
    composing = false;
    resetInput();
  };

  const listeners = [
    ['compositionstart', onCompositionStart],
    ['compositionupdate', onCompositionUpdate],
    ['compositionend', onCompositionEnd],
    ['keydown', onKeyDown],
    ['beforeinput', onBeforeInput],
    ['input', onInput],
    ['blur', onBlur],
  ];
  for (const [type, listener] of listeners) eventTarget.addEventListener(type, listener, true);

  return () => {
    cancelReconcile();
    for (const [type, listener] of listeners) eventTarget.removeEventListener(type, listener, true);
  };
}

module.exports = { installAndroidImeBridge, terminalInputDelta };
