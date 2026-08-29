function createTerminalPasteBridge(
  terminal,
  emitInput,
  eventTarget = window,
  onDidPaste = () => {}
) {
  const input = terminal.textarea;
  let pasteBuffer = null;
  let suppressPasteInput = false;
  let suppressBeforeInputCommit = false;

  const isTerminalInput = event => {
    if (!input) return false;
    if (event.target === input) return true;
    const element = terminal.element;
    return Boolean(
      element
      && typeof element.contains === 'function'
      && element.contains(event.target)
    );
  };
  const clipboardText = event => {
    const transfer = event.clipboardData || event.dataTransfer;
    if (transfer && typeof transfer.getData === 'function') {
      try {
        const text = transfer.getData('text/plain');
        if (typeof text === 'string') return { available: true, text };
      } catch (_error) {}
    }
    if (typeof event.data === 'string') {
      return { available: true, text: event.data };
    }
    return { available: false, text: '' };
  };
  const stopXtermAndIme = (event, preventDefault) => {
    if (preventDefault && typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    } else if (typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
  };
  const finishPaste = () => {
    if (input) input.value = '';
    onDidPaste();
  };
  const paste = text => {
    const outermost = pasteBuffer === null;
    if (outermost) pasteBuffer = '';
    try {
      terminal.paste(text);
    } finally {
      if (outermost) {
        const data = pasteBuffer;
        pasteBuffer = null;
        finishPaste();
        if (data) emitInput(data, 'paste');
      }
    }
  };
  const handleData = data => {
    if (pasteBuffer !== null) pasteBuffer += data;
    else emitInput(data, 'keyboard');
  };
  const onPaste = event => {
    if (!isTerminalInput(event)) return;
    const payload = clipboardText(event);
    if (!payload.available) return;
    stopXtermAndIme(event, true);
    suppressPasteInput = true;
    suppressBeforeInputCommit = false;
    try {
      paste(payload.text);
    } catch (error) {
      suppressPasteInput = false;
      throw error;
    }
  };
  const onBeforeInput = event => {
    if (!isTerminalInput(event)) return;
    if (event.inputType !== 'insertFromPaste') {
      suppressPasteInput = false;
      suppressBeforeInputCommit = false;
      return;
    }
    if (suppressPasteInput) {
      stopXtermAndIme(event, true);
      return;
    }
    const payload = clipboardText(event);
    if (!payload.available) return;
    stopXtermAndIme(event, true);
    suppressBeforeInputCommit = true;
    try {
      paste(payload.text);
    } catch (error) {
      suppressBeforeInputCommit = false;
      throw error;
    }
  };
  const onInput = event => {
    if (!isTerminalInput(event)) return;
    if (event.inputType !== 'insertFromPaste') {
      suppressPasteInput = false;
      suppressBeforeInputCommit = false;
      return;
    }
    if (suppressPasteInput || suppressBeforeInputCommit) {
      stopXtermAndIme(event, false);
      if (input) input.value = '';
      suppressBeforeInputCommit = false;
      return;
    }
    const payload = clipboardText(event);
    if (!payload.available) return;
    stopXtermAndIme(event, false);
    paste(payload.text);
  };

  const listeners = [
    ['paste', onPaste],
    ['beforeinput', onBeforeInput],
    ['input', onInput],
  ];
  for (const [type, listener] of listeners) {
    eventTarget.addEventListener(type, listener, true);
  }

  return {
    dispose: () => {
      pasteBuffer = null;
      suppressPasteInput = false;
      suppressBeforeInputCommit = false;
      for (const [type, listener] of listeners) {
        eventTarget.removeEventListener(type, listener, true);
      }
    },
    handleData,
    isPasting: () => pasteBuffer !== null,
    paste,
  };
}

module.exports = { createTerminalPasteBridge };
