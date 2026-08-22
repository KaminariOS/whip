/** Match xterm's paste preparation before text crosses the native bridge. */
export function prepareTerminalPaste(text: string): string {
  return text.replace(/\r?\n/g, '\r').split('\u001b').join('\u241b');
}
