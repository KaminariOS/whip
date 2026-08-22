import type { Styles, XmlAST } from 'react-native-svg';

const DISALLOWED_SVG_TAGS = new Set(['foreignobject', 'script']);
const EMBEDDED_IMAGE_REFERENCE = /^data:image\/(?:gif|jpeg|jpg|png|webp);base64,/i;
const IMPORTANT_PRIORITY = /\s*!important\s*$/i;
const URL_REFERENCE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

export function sanitizeRemoteSvgAst(root: XmlAST): XmlAST {
  if (root.tag.toLowerCase() !== 'svg') {
    throw new Error('The document root must be an SVG element');
  }
  addFallbackViewBox(root);
  sanitizeNode(root);
  return root;
}

function addFallbackViewBox(root: XmlAST): void {
  if (root.props.viewBox) return;
  const width = absoluteSvgLength(root.props.width);
  const height = absoluteSvgLength(root.props.height);
  if (width && height) root.props.viewBox = `0 0 ${width} ${height}`;
}

function absoluteSvgLength(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  const length = Number(match?.[1]);
  return Number.isFinite(length) && length > 0 ? length : null;
}

function sanitizeNode(node: XmlAST): void {
  sanitizeProperties(node.props);
  node.children = node.children.filter(child => {
    if (typeof child === 'string') return true;
    if (DISALLOWED_SVG_TAGS.has(child.tag.toLowerCase())) return false;
    sanitizeNode(child);
    return true;
  });
}

function sanitizeProperties(properties: XmlAST['props']): void {
  for (const [name, value] of Object.entries(properties)) {
    if (/^on/i.test(name)) {
      delete properties[name];
      continue;
    }
    if ((name === 'href' || name === 'xlinkHref') && typeof value === 'string') {
      if (!isSafeHref(value)) delete properties[name];
      continue;
    }
    if (typeof value === 'string' && hasExternalUrl(value)) {
      delete properties[name];
      continue;
    }
    if (name === 'style' && value && typeof value === 'object') {
      sanitizeStyle(value);
    }
  }
}

function sanitizeStyle(style: Styles): void {
  for (const [name, value] of Object.entries(style)) {
    if (hasExternalUrl(value)) {
      delete style[name];
      continue;
    }
    // react-native-svg forwards CSS priority markers to native property parsers.
    // Android's SVGLength parser treats the entire value as a number and throws.
    style[name] = value.replace(IMPORTANT_PRIORITY, '');
  }
}

function isSafeHref(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('#') || EMBEDDED_IMAGE_REFERENCE.test(trimmed);
}

function hasExternalUrl(value: string): boolean {
  URL_REFERENCE.lastIndex = 0;
  for (const match of value.matchAll(URL_REFERENCE)) {
    if (!match[2].trim().startsWith('#')) return true;
  }
  return false;
}
