import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { OverlayScrollbar } from '../src/components/OverlayScrollbar';

let mockPanResponderConfig: Record<string, (...args: unknown[]) => unknown>;

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  PanResponder: {
    create: (config: typeof mockPanResponderConfig) => {
      mockPanResponderConfig = config;
      return { panHandlers: { testPanHandlers: true } };
    },
  },
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
  View: 'View',
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  cancelAnimation: jest.fn(),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) =>
    jest.requireActual('react').useRef({ value }).current,
  withTiming: (value: unknown) => value,
}));
jest.mock('../src/components/app-ui', () => ({
  useReducedMotion: () => false,
}));
jest.mock('../src/theme', () => ({
  colorWithAlpha: (color: string, alpha: string) => `${color}${alpha}`,
  useTheme: () => ({
    colors: { surface: '#111111', text: '#eeeeee', textSecondary: '#777777' },
  }),
}));

function styleObject(node: ReactTestInstance): Record<string, unknown> {
  return Object.assign({}, ...node.props.style.filter(Boolean));
}

describe('OverlayScrollbar', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => act(() => renderer?.unmount()));

  test('applies viewport occlusion and exposes a usable drag target', () => {
    const onDragStart = jest.fn();
    const onDragEnd = jest.fn();
    act(() => {
      renderer = create(
        <OverlayScrollbar
          accessibilityLabel="Terminal scroll position"
          heightPercent={20}
          insets={{ top: 92, bottom: 186 }}
          topPercent={50}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />,
      );
    });

    const track = renderer.root.find(
      node => String(node.type) === 'View' && node.props.onLayout,
    );
    expect(styleObject(track)).toMatchObject({
      top: 92,
      bottom: 186,
      width: 40,
    });

    void act(() =>
      track.props.onLayout({ nativeEvent: { layout: { height: 200 } } }),
    );
    const hitTarget = renderer.root.find(
      node =>
        String(node.type) === 'View' &&
        node.props.accessibilityRole === 'adjustable',
    );
    expect(styleObject(hitTarget)).toMatchObject({ height: 44, width: 40 });

    void act(() => {
      mockPanResponderConfig.onPanResponderGrant();
    });
    expect(onDragStart).toHaveBeenCalledWith({
      trackHeight: 200,
      thumbHeight: 40,
    });
    const activeThumb = renderer.root.find(
      node => String(node.type) === 'AnimatedView',
    );
    expect(styleObject(activeThumb)).toMatchObject({
      backgroundColor: '#777777',
      opacity: 0.82,
      width: 22,
    });

    void act(() => {
      mockPanResponderConfig.onPanResponderRelease();
    });
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    const idleThumb = renderer.root.find(
      node => String(node.type) === 'AnimatedView',
    );
    expect(styleObject(idleThumb)).toMatchObject({
      backgroundColor: '#111111B8',
      borderWidth: 1,
      opacity: 0.72,
      width: 14,
    });
  });
});
