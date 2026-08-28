const MAX_TRANSCRIPT_LINES = 5000;
const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;

// OSC commands can mutate terminal state (including the clipboard and title) when
// replayed. Keep CSI styling for xterm, but remove those side effects from a cache.
// eslint-disable-next-line no-control-regex -- OSC sanitization must match literal terminal control bytes.
const OSC_SEQUENCE = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g;

function safeTerminalState(value: string): string {
  return value.replace(OSC_SEQUENCE, '');
}

export function terminalTranscript(value: string, requestedLines: number): string {
  const lineLimit = Math.max(1, Math.min(
    MAX_TRANSCRIPT_LINES,
    Math.round(requestedLines) || 1,
  ));
  const safe = safeTerminalState(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .slice(-lineLimit)
    .join('\r\n');
  return safe.length <= MAX_TRANSCRIPT_CHARACTERS
    ? safe
    : safe.slice(-MAX_TRANSCRIPT_CHARACTERS);
}

/** Bounds and removes side-effecting OSC from xterm's serialized state. */
export function terminalSerializedTranscript(value: string): string {
  const safe = safeTerminalState(value);
  if (safe.length <= MAX_TRANSCRIPT_CHARACTERS) return safe;
  const clipped = safe.slice(-MAX_TRANSCRIPT_CHARACTERS);
  const firstRowBoundary = clipped.indexOf('\r\n');
  return firstRowBoundary >= 0 ? clipped.slice(firstRowBoundary + 2) : clipped;
}
