import type { XmlAST } from 'react-native-svg';

import { sanitizeRemoteSvgAst } from '../src/lib/svgPreview';

function node(tag: string, props: XmlAST['props'] = {}, children: XmlAST['children'] = []): XmlAST {
  return {
    tag,
    props,
    children,
    parent: null,
    Tag: (() => null) as XmlAST['Tag'],
  };
}

describe('remote SVG sanitization', () => {
  it('retains local fragment and embedded image references', () => {
    const localUse = node('use', { href: '#symbol' });
    const embeddedImage = node('image', { href: 'data:image/png;base64,AAAA' });
    const root = node('svg', {}, [localUse, embeddedImage]);

    sanitizeRemoteSvgAst(root);

    expect(localUse.props.href).toBe('#symbol');
    expect(embeddedImage.props.href).toBe('data:image/png;base64,AAAA');
  });

  it('derives a viewBox from absolute dimensions for fit-to-view rendering', () => {
    const root = node('svg', { width: '640px', height: '480' });

    sanitizeRemoteSvgAst(root);

    expect(root.props.viewBox).toBe('0 0 640 480');
  });

  it('removes executable nodes, event handlers, and external references', () => {
    const externalImage = node('image', { href: 'https://example.com/tracker.png' });
    const interactiveRect = node('rect', {
      fill: 'url(https://example.com/fill.svg#paint)',
      onLoad: 'alert(1)',
      style: { stroke: 'url(#local)', fill: 'url(https://example.com/paint)' },
    });
    const root = node('svg', {}, [
      externalImage,
      interactiveRect,
      node('script'),
      node('foreignObject'),
    ]);

    sanitizeRemoteSvgAst(root);

    expect(externalImage.props.href).toBeUndefined();
    expect(interactiveRect.props.fill).toBeUndefined();
    expect(interactiveRect.props.onLoad).toBeUndefined();
    expect(interactiveRect.props.style).toEqual({ stroke: 'url(#local)' });
    expect(root.children).toEqual([externalImage, interactiveRect]);
  });

  it('rejects documents without an SVG root element', () => {
    expect(() => sanitizeRemoteSvgAst(node('html'))).toThrow('root must be an SVG');
  });
});
