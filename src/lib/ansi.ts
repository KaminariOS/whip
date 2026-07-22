export interface AnsiStyle {
  foreground?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const BASIC_COLORS = [
  '#15161e', '#f7768e', '#9ece6a', '#e0af68',
  '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
  '#414868', '#ff899d', '#9fe044', '#faba4a',
  '#8db0ff', '#c7a9ff', '#a4daff', '#c0caf5',
];

// Terminal escape bytes are the subject of this parser.
// eslint-disable-next-line no-control-regex
const CONTROL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function parseAnsi(value: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let state: AnsiStyle = {};
  let offset = 0;

  for (const match of value.matchAll(CONTROL_SEQUENCE)) {
    const index = match.index ?? 0;
    appendSegment(segments, normalizeText(value.slice(offset, index)), state);
    const sequence = match[0];
    if (sequence.endsWith('m') && sequence.startsWith('\u001b[')) {
      state = applySgr(state, sequence.slice(2, -1));
    }
    offset = index + sequence.length;
  }

  appendSegment(segments, normalizeText(value.slice(offset)), state);
  return segments;
}

export function dominantAnsiBackground(segments: AnsiSegment[], fallback: string): string {
  const weights = new Map<string, number>();
  for (const segment of segments) {
    const style = resolvedStyle(segment.style);
    if (!style.background) continue;
    weights.set(style.background, (weights.get(style.background) || 0) + segment.text.length);
  }
  return [...weights.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || fallback;
}

export function resolvedStyle(style: AnsiStyle): AnsiStyle {
  if (!style.reverse) return style;
  return {
    ...style,
    foreground: style.background,
    background: style.foreground,
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

function appendSegment(segments: AnsiSegment[], text: string, style: AnsiStyle): void {
  if (!text) return;
  const key = styleKey(style);
  const previous = segments[segments.length - 1];
  if (previous && styleKey(previous.style) === key) {
    previous.text += text;
  } else {
    segments.push({ text, style: { ...style } });
  }
}

function applySgr(current: AnsiStyle, body: string): AnsiStyle {
  const params = body === '' ? [0] : body.split(';').map(value => Number(value.split(':')[0] || 0));
  let style = { ...current };

  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (code === 0) style = {};
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.reverse = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.reverse = false;
    else if (code >= 30 && code <= 37) style.foreground = BASIC_COLORS[code - 30];
    else if (code === 39) style.foreground = undefined;
    else if (code >= 40 && code <= 47) style.background = BASIC_COLORS[code - 40];
    else if (code === 49) style.background = undefined;
    else if (code >= 90 && code <= 97) style.foreground = BASIC_COLORS[8 + code - 90];
    else if (code >= 100 && code <= 107) style.background = BASIC_COLORS[8 + code - 100];
    else if (code === 38 || code === 48) {
      const color = readExtendedColor(params, index + 1);
      if (color) {
        if (code === 38) style.foreground = color.value;
        else style.background = color.value;
        index = color.lastIndex;
      }
    }
  }
  return style;
}

function readExtendedColor(params: number[], start: number): { value: string; lastIndex: number } | null {
  if (params[start] === 2 && params.length > start + 3) {
    return {
      value: `#${params.slice(start + 1, start + 4).map(hexByte).join('')}`,
      lastIndex: start + 3,
    };
  }
  if (params[start] === 5 && params.length > start + 1) {
    return { value: indexedColor(params[start + 1]), lastIndex: start + 1 };
  }
  return null;
}

function indexedColor(value: number): string {
  const index = Math.max(0, Math.min(255, value));
  if (index < 16) return BASIC_COLORS[index];
  if (index < 232) {
    const offset = index - 16;
    const red = Math.floor(offset / 36);
    const green = Math.floor((offset % 36) / 6);
    const blue = offset % 6;
    const level = (component: number) => component === 0 ? 0 : 55 + component * 40;
    return `#${[level(red), level(green), level(blue)].map(hexByte).join('')}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${hexByte(gray).repeat(3)}`;
}

function hexByte(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

function styleKey(style: AnsiStyle): string {
  return [
    style.foreground,
    style.background,
    style.bold,
    style.dim,
    style.italic,
    style.underline,
    style.reverse,
  ].join('|');
}
