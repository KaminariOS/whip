import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { HtmlPreview } from '../src/components/HtmlPreview';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  StyleSheet: {
    create: <T,>(styles: T) => styles,
  },
}));
jest.mock('react-native-webview', () => ({
  __esModule: true,
  default: 'WebView',
}));

describe('HtmlPreview', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test.each([
    ['http://127.0.0.1:41000/index.html', 'http://127.0.0.1:41000/index.html?__whip_preview=7'],
    ['http://127.0.0.1:41000/index.html?theme=dark', 'http://127.0.0.1:41000/index.html?theme=dark&__whip_preview=7'],
  ])('loads the tunneled page with a revision cache buster', (uri, expectedUri) => {
    act(() => {
      renderer = create(<HtmlPreview filename="index.html" revision={7} uri={uri} />);
    });

    const webView = renderer.root.find(node => (node.type as unknown) === 'WebView');
    expect(webView.props).toEqual(expect.objectContaining({
      accessibilityLabel: 'Preview index.html',
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      cacheEnabled: false,
      domStorageEnabled: true,
      javaScriptCanOpenWindowsAutomatically: false,
      javaScriptEnabled: true,
      originWhitelist: ['http://*', 'https://*'],
      setSupportMultipleWindows: false,
      source: { uri: expectedUri },
      thirdPartyCookiesEnabled: false,
    }));
  });
});
