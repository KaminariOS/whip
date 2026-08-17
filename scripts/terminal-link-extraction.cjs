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

function osc8LinkFromData(data) {
  const separator = data.indexOf(';');
  if (separator < 0) return null;
  const value = data.slice(separator + 1);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function terminalLinkCandidates(rows, columns) {
  const logicalLines = [];
  let logicalLine = null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.isWrapped || !logicalLine) {
      if (logicalLine) logicalLines.push(logicalLine);
      logicalLine = { text: '', segments: [], endsAtColumnBoundary: false };
    }

    const nextIsWrapped = Boolean(rows[index + 1]?.isWrapped);
    const text = nextIsWrapped ? row.text : row.text.trimEnd();
    logicalLine.segments.push({
      row: index,
      column: 0,
      start: logicalLine.text.length,
      end: logicalLine.text.length + text.length,
    });
    logicalLine.text += text;
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
    const segments = [...line.segments];
    let current = index;
    const urlAtEnd = text.match(/https?:[/]{2}[^\s<>"']+$/i);
    if (!urlAtEnd) return { text, segments };

    const prefix = text.slice(0, urlAtEnd.index);
    const repeatsPresentationPrefix = prefix.length > 0
      && !/[A-Za-z0-9]/.test(prefix)
      && prefix + urlAtEnd[0] === text;

    while (current + 1 < logicalLines.length) {
      const next = logicalLines[current + 1];
      let continuation = null;
      let continuationStart = 0;
      if (repeatsPresentationPrefix) {
        const repeatsPrefix = next.text.startsWith(prefix);
        const preservesContentColumn = next.text.slice(0, prefix.length).trim() === '';
        if (repeatsPrefix || preservesContentColumn) {
          continuationStart = prefix.length;
          continuation = next.text.slice(prefix.length).match(/^[^\s<>"']+/)?.[0] || null;
        }
      } else if (logicalLines[current]?.endsAtColumnBoundary) {
        continuation = next.text.match(/^[^\s<>"']+/)?.[0] || null;
      }
      if (!continuation || /^https?:[/]{2}/i.test(continuation)) break;
      const appendedAt = text.length;
      const continuationEnd = continuationStart + continuation.length;
      for (const segment of next.segments) {
        const overlapStart = Math.max(segment.start, continuationStart);
        const overlapEnd = Math.min(segment.end, continuationEnd);
        if (overlapStart >= overlapEnd) continue;
        segments.push({
          row: segment.row,
          column: segment.column + overlapStart - segment.start,
          start: appendedAt + overlapStart - continuationStart,
          end: appendedAt + overlapEnd - continuationStart,
        });
      }
      text += continuation;
      current += 1;
      if (continuationEnd < next.text.length) break;
    }
    return { text, segments };
  });

  const candidates = [];
  for (let index = scanLines.length - 1; index >= 0; index -= 1) {
    const { text, segments } = scanLines[index];
    const matches = [...text.matchAll(/https?:[/]{2}[^\s<>"']+/gi)];
    for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
      const value = trimTerminalUrl(matches[matchIndex][0]);
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) continue;
        const start = matches[matchIndex].index || 0;
        const end = start + value.length;
        candidates.push({
          href: parsed.href,
          cells: segments.flatMap(segment => {
            const overlapStart = Math.max(segment.start, start);
            const overlapEnd = Math.min(segment.end, end);
            return overlapStart < overlapEnd ? [{
              row: segment.row,
              start: segment.column + overlapStart - segment.start,
              end: segment.column + overlapEnd - segment.start,
            }] : [];
          }),
        });
      } catch {}
    }
  }
  return candidates;
}

function extractTerminalLinks(rows, columns) {
  const links = [];
  const seen = new Set();
  for (const candidate of terminalLinkCandidates(rows, columns)) {
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    links.push(candidate.href);
  }
  return links;
}

function mergeTerminalLinks(rows, columns, osc8Links) {
  const candidates = terminalLinkCandidates(rows, columns).map((candidate, index) => ({
    href: candidate.href,
    row: candidate.cells.reduce((latest, cell) => Math.max(latest, cell.row), -1),
    sequence: -index,
  }));
  for (const link of osc8Links) {
    if (link.marker.line < 0) continue;
    const endRow = link.endMarker?.line ?? link.marker.line;
    candidates.push({ href: link.href, row: Math.max(link.marker.line, endRow), sequence: link.sequence });
  }
  candidates.sort((left, right) => right.row - left.row || right.sequence - left.sequence);

  const links = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    links.push(candidate.href);
  }
  return links;
}

function osc8LinkAt(osc8Links, row, column) {
  let match = null;
  for (const link of osc8Links) {
    const startRow = link.marker.line;
    const endRow = link.endMarker?.line ?? -1;
    if (startRow < 0 || endRow < startRow || link.endColumn === null) continue;
    const afterStart = row > startRow || (row === startRow && column >= link.startColumn);
    const beforeEnd = row < endRow || (row === endRow && column < link.endColumn);
    if (afterStart && beforeEnd && (!match || link.sequence > match.sequence)) match = link;
  }
  return match?.href || null;
}

function terminalLinkAt(rows, columns, row, column) {
  return terminalLinkCandidates(rows, columns).find(candidate =>
    candidate.cells.some(range =>
      range.row === row && column >= range.start && column < range.end
    )
  )?.href || null;
}

module.exports = {
  extractTerminalLinks,
  mergeTerminalLinks,
  osc8LinkAt,
  osc8LinkFromData,
  terminalLinkAt,
  terminalLinkCandidates,
  trimTerminalUrl,
};
