const MAX_TRANSCRIPT_LINES = 5000;
const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;

// OSC commands can mutate terminal state (including the clipboard and title) when
// replayed. Keep CSI styling for xterm, but remove those side effects from a cache.
// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function terminalTranscript(value: string, requestedLines: number): string {
  const lineLimit = Math.max(1, Math.min(
    MAX_TRANSCRIPT_LINES,
    Math.round(requestedLines) || 1,
  ));
  const safe = value
    .replace(OSC_SEQUENCE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .slice(-lineLimit)
    .join('\r\n');
  return safe.length <= MAX_TRANSCRIPT_CHARACTERS
    ? safe
    : safe.slice(-MAX_TRANSCRIPT_CHARACTERS);
}
