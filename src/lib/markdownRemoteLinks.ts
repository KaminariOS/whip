import { parentRemotePath } from './remoteFiles';

export interface MarkdownImageTarget {
  target: string;
  start: number;
  end: number;
}

export function resolveRemoteMarkdownPath(markdownPath: string, target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return null;

  const pathOnly = trimmed.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    decoded = pathOnly;
  }
  const combined = decoded.startsWith('/')
    ? decoded
    : `${parentRemotePath(markdownPath)}/${decoded}`;
  const segments: string[] = [];
  for (const segment of combined.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function markdownImageTargets(markdown: string): MarkdownImageTarget[] {
  const targets: MarkdownImageTarget[] = [];
  const referenceLabels = new Set<string>();
  const codeRanges = markdownCodeRanges(markdown);
  let cursor = 0;
  while (cursor < markdown.length - 3) {
    const imageStart = markdown.indexOf('![', cursor);
    if (imageStart < 0) break;
    const codeRange = codeRanges.find(range => imageStart >= range.start && imageStart < range.end);
    if (codeRange) {
      cursor = codeRange.end;
      continue;
    }
    const labelEnd = closingBracket(markdown, imageStart + 2, ']');
    if (labelEnd < 0) break;
    let destinationStart = labelEnd + 1;
    while (/\s/.test(markdown[destinationStart] || '')) destinationStart += 1;
    if (markdown[destinationStart] !== '(') {
      if (markdown[destinationStart] === '[') {
        const referenceEnd = closingBracket(markdown, destinationStart + 1, ']');
        if (referenceEnd >= 0) {
          const explicitLabel = markdown.slice(destinationStart + 1, referenceEnd);
          referenceLabels.add(normalizeReferenceLabel(explicitLabel || markdown.slice(imageStart + 2, labelEnd)));
        }
      } else {
        referenceLabels.add(normalizeReferenceLabel(markdown.slice(imageStart + 2, labelEnd)));
      }
      cursor = labelEnd + 1;
      continue;
    }
    destinationStart += 1;
    while (/\s/.test(markdown[destinationStart] || '')) destinationStart += 1;

    let targetStart = destinationStart;
    let targetEnd = destinationStart;
    if (markdown[destinationStart] === '<') {
      targetStart += 1;
      targetEnd = closingBracket(markdown, targetStart, '>');
    } else {
      let nestedParentheses = 0;
      while (targetEnd < markdown.length) {
        const character = markdown[targetEnd];
        if (character === '\\') {
          targetEnd += 2;
          continue;
        }
        if (character === '(') nestedParentheses += 1;
        else if (character === ')') {
          if (nestedParentheses === 0) break;
          nestedParentheses -= 1;
        } else if (/\s/.test(character) && nestedParentheses === 0) {
          break;
        }
        targetEnd += 1;
      }
    }
    if (targetEnd > targetStart) {
      targets.push({
        target: markdown.slice(targetStart, targetEnd).replace(/\\([\\`*{}\[\]()#+.!_>-])/g, '$1'),
        start: targetStart,
        end: targetEnd,
      });
    }
    cursor = Math.max(targetEnd + 1, labelEnd + 1);
  }

  const seenDefinitions = new Set<string>();
  const definition = /^(?: {0,3})\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s\n]+))/gm;
  for (const match of markdown.matchAll(definition)) {
    if (codeRanges.some(range => (match.index || 0) >= range.start && (match.index || 0) < range.end)) continue;
    const label = normalizeReferenceLabel(match[1]);
    if (!referenceLabels.has(label) || seenDefinitions.has(label)) continue;
    seenDefinitions.add(label);
    const target = match[2] || match[3];
    const targetOffset = match[0].indexOf(target);
    const start = (match.index || 0) + targetOffset;
    targets.push({ target, start, end: start + target.length });
  }

  return targets;
}

export function rewriteMarkdownImages(
  markdown: string,
  replacementFor: (target: string) => string | undefined,
): string {
  let rewritten = markdown;
  for (const image of markdownImageTargets(markdown).reverse()) {
    const replacement = replacementFor(image.target);
    if (!replacement) continue;
    rewritten = `${rewritten.slice(0, image.start)}${replacement}${rewritten.slice(image.end)}`;
  }
  return rewritten;
}

function closingBracket(value: string, start: number, bracket: string): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '\\') index += 1;
    else if (value[index] === bracket) return index;
    else if (value[index] === '\n') return -1;
  }
  return -1;
}

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function markdownCodeRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let fence: { start: number; marker: string; length: number } | null = null;
  let lineStart = 0;
  while (lineStart < markdown.length) {
    const newline = markdown.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? markdown.length : newline + 1;
    const line = markdown.slice(lineStart, newline < 0 ? markdown.length : newline);
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (!fence && marker) {
      fence = { start: lineStart, marker: marker[0], length: marker.length };
    } else if (fence && marker?.[0] === fence.marker && marker.length >= fence.length
      && line.slice(line.indexOf(marker) + marker.length).trim() === '') {
      ranges.push({ start: fence.start, end: lineEnd });
      fence = null;
    }
    lineStart = lineEnd;
  }
  if (fence) ranges.push({ start: fence.start, end: markdown.length });

  let cursor = 0;
  while (cursor < markdown.length) {
    const start = markdown.indexOf('`', cursor);
    if (start < 0) break;
    const fenced = ranges.find(range => start >= range.start && start < range.end);
    if (fenced) {
      cursor = fenced.end;
      continue;
    }
    let runLength = 1;
    while (markdown[start + runLength] === '`') runLength += 1;
    const delimiter = '`'.repeat(runLength);
    let end = markdown.indexOf(delimiter, start + runLength);
    while (end >= 0 && (markdown[end - 1] === '`' || markdown[end + runLength] === '`')) {
      end = markdown.indexOf(delimiter, end + runLength);
    }
    if (end < 0) {
      cursor = start + runLength;
      continue;
    }
    ranges.push({ start, end: end + runLength });
    cursor = end + runLength;
  }
  return ranges.sort((left, right) => left.start - right.start);
}
