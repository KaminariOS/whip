import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { FullScreenOverlay } from '../src/components/FullScreenOverlay';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  StyleSheet: {
    create: <T,>(styles: T) => styles,
  },
  View: 'View',
}));

describe('FullScreenOverlay', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test('fills the app and stays above kept-mounted navigation screens', () => {
    act(() => {
      renderer = create(<FullScreenOverlay>license content</FullScreenOverlay>);
    });

    const overlay = renderer.root.find(node => (node.type as unknown) === 'View');
    expect(overlay.props.style).toEqual({
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: 60,
    });
  });
});
