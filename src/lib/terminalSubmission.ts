export interface TerminalSubmission {
  historyEntry: string;
  pasteEvents: string[];
}

/**
 * Keep composer text and attachments as distinct paste events. The renderer
 * inserts separators outside those events before sending Enter.
 */
export function composeTerminalSubmission(
  text: string,
  attachmentPaths: readonly string[],
): TerminalSubmission {
  const pasteEvents = [text.trimEnd(), ...attachmentPaths].filter(Boolean);
  return {
    historyEntry: pasteEvents.join(' '),
    pasteEvents,
  };
}

/** Convert xterm's captured paste output into ordered terminal writes. */
export function terminalSubmissionWrites(pastedParts: readonly string[]): string[] {
  const writes: string[] = [];
  for (const part of pastedParts) {
    if (writes.length > 0) writes.push(' ');
    writes.push(part);
  }
  writes.push('\r');
  return writes;
}
