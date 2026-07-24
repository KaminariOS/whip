function trimTerminalUrl(candidate) {
  let value = candidate.replace(/[.,;:!?]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    const opens = value.split(open).length - 1;
    let closes = value.split(close).length - 1;
    while (value.endsWith(close) && closes > opens) {
      value = value.slice(0, -1);
      closes -= 1;
    }
  }
  return value;
}

function extractTerminalLinks(rows, columns) {
  const logicalLines = [];
  let logicalLine = null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.isWrapped || !logicalLine) {
      if (logicalLine) logicalLines.push(logicalLine);
      logicalLine = { text: '', endsAtColumnBoundary: false };
    }

    const nextIsWrapped = Boolean(rows[index + 1]?.isWrapped);
    logicalLine.text += nextIsWrapped ? row.text : row.text.trimEnd();
    logicalLine.endsAtColumnBoundary = !nextIsWrapped
      && columns > 0
      && row.text.trimEnd().length >= columns;
  }
  if (logicalLine) logicalLines.push(logicalLine);

  // Some programs hard-wrap output by writing a newline at the terminal edge.
  // Terminal UIs can also wrap a URL inside a decorated block, repeating a
  // presentation prefix such as "  ┃  " on every continuation row.
  const scanLines = logicalLines.map((line, index) => {
    let text = line.text;
    let current = index;
    const urlAtEnd = text.match(/https?:[/]{2}[^\s<>"']+$/i);
    if (!urlAtEnd) return text;

    const prefix = text.slice(0, urlAtEnd.index);
    const repeatsPresentationPrefix = prefix.length > 0
      && !/[A-Za-z0-9]/.test(prefix)
      && prefix + urlAtEnd[0] === text;

    while (current + 1 < logicalLines.length) {
      const next = logicalLines[current + 1];
      let continuation = null;
      if (repeatsPresentationPrefix) {
        const repeatsPrefix = next.text.startsWith(prefix);
        const preservesContentColumn = next.text.slice(0, prefix.length).trim() === '';
        if (repeatsPrefix || preservesContentColumn) {
          continuation = next.text.slice(prefix.length).match(/^[^\s<>"']+$/)?.[0] || null;
        }
      } else if (logicalLines[current]?.endsAtColumnBoundary) {
        continuation = next.text.match(/^[^\s<>"']+$/)?.[0] || null;
      }
      if (!continuation || /^https?:[/]{2}/i.test(continuation)) break;
      text += continuation;
      current += 1;
    }
    return text;
  });

  const links = [];
  const seen = new Set();
  for (let index = scanLines.length - 1; index >= 0; index -= 1) {
    const matches = [...scanLines[index].matchAll(/https?:[/]{2}[^\s<>"']+/gi)];
    for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
      const value = trimTerminalUrl(matches[matchIndex][0]);
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || seen.has(parsed.href)) continue;
        seen.add(parsed.href);
        links.push(parsed.href);
      } catch {}
    }
  }
  return links;
}

module.exports = { extractTerminalLinks, trimTerminalUrl };
