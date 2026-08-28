import { Fragment, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { emptyTranscript } from '../src/agentChat';
import { AgentChatView } from '../src/components/AgentChatView';

jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Clipboard: { setString: jest.fn() },
  FlatList: 'FlatList',
  Linking: { openURL: jest.fn(async () => undefined) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  cancelAnimation: jest.fn(),
  Easing: { inOut: (value: unknown) => value, quad: 'quad' },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withSequence: (...values: unknown[]) => values.at(-1),
  withTiming: (value: unknown) => value,
}));
jest.mock('../src/components/app-ui', () => ({
  useReducedMotion: () => true,
}));
jest.mock('../src/components/GlassSurface', () => ({
  useAppGlassEnabled: () => false,
}));
jest.mock('../src/components/MarkdownText', () => ({
  MarkdownText: 'MarkdownText',
}));
jest.mock('../src/components/OverlayScrollbar', () => ({
  OverlayScrollbar: 'OverlayScrollbar',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: () => ({}),
  recordOperationalDiagnostic: jest.fn(),
}));
jest.mock('../src/theme', () => ({
  appGlassControlStyle: () => undefined,
  useTheme: () => ({
    colors: {
      error: '#f00',
      primary: '#00f',
      textSecondary: '#333',
      textTertiary: '#666',
    },
  }),
}));

describe('AgentChatView viewport insets', () => {
  let renderer: ReactTestRenderer;
  let boundaries: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    act(() => boundaries?.unmount());
  });

  test('keeps the viewport edge-to-edge while insetting content and indicators', () => {
    const contentInsets = { top: 92, bottom: 186 };
    act(() => {
      renderer = create(
        <AgentChatView
          agent="codex"
          agentStatus="idle"
          contentInsets={contentInsets}
          onOpenFile={jest.fn()}
          state={{
            sessionId: 'session-1',
            transcript: emptyTranscript('session-1'),
            status: 'live',
          }}
        />,
      );
    });

    const list = renderer.root.find(node => String(node.type) === 'FlatList');
    expect(list.props.scrollIndicatorInsets).toEqual(contentInsets);
    expect(list.props.contentContainerClassName).toBe('flex-grow px-4');

    act(() => {
      boundaries = create(
        <Fragment>
          {list.props.ListHeaderComponent as ReactElement}
          {list.props.ListFooterComponent as ReactElement}
        </Fragment>,
      );
    });
    const spacerHeights = boundaries.root
      .findAll(node => String(node.type) === 'View')
      .flatMap(node =>
        typeof node.props.style?.height === 'number'
          ? [node.props.style.height]
          : [],
      );
    expect(spacerHeights).toEqual([108, 210]);
  });
});
