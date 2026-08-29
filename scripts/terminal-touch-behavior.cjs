function handleKeyboardClosedStationaryTap({
  point,
  urlAtPoint,
  terminalMouseCaptured,
  dispatchTerminalClick,
  send,
  clearInteractiveSelection,
}) {
  const link = urlAtPoint(point.clientX, point.clientY);
  if (link) {
    send({ type: 'open-link', link });
    return;
  }
  if (terminalMouseCaptured()) {
    dispatchTerminalClick(point);
    return;
  }
  clearInteractiveSelection(true);
}

function forcedTerminalMouseInputSequence(enabled) {
  return enabled
    ? '\u001b[?1000h\u001b[?1006h'
    : '\u001b[?1000l\u001b[?1006l';
}

function setTerminalKeyboardInputEnabled(terminal, enabled) {
  const keyboardEnabled = enabled !== false;
  const input = terminal.textarea;
  if (input) {
    input.readOnly = !keyboardEnabled;
    input.inputMode = keyboardEnabled ? '' : 'none';
  }
  if (!keyboardEnabled) terminal.blur();
  return keyboardEnabled;
}

module.exports = {
  forcedTerminalMouseInputSequence,
  handleKeyboardClosedStationaryTap,
  setTerminalKeyboardInputEnabled,
};
