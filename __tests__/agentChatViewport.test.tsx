import { Fragment, type ReactElement } from 'react';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { emptyTranscript, type AgentChatState, type TranscriptTurn } from '../src/agentChat';
import { AgentChatView } from '../src/components/AgentChatView';

jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('react-native-code-highlighter', () => 'CodeHighlighter');
jest.mock('react-syntax-highlighter/dist/esm/styles/hljs', () => ({
  atomOneDarkReasonable: {},
  atomOneLight: {},
}));
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
  StyleSheet: { create: (styles: unknown) => styles },
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
    isDark: false,
    colors: {
      error: '#f00',
      primary: '#00f',
      textSecondary: '#333',
      textTertiary: '#666',
    },
  }),
}));

const CONTENT_INSETS = { top: 0, bottom: 186 };

function chatState(turns: TranscriptTurn[]): AgentChatState {
  return {
    sessionId: 'session-1',
    transcript: { ...emptyTranscript('session-1'), turns },
    status: 'live',
  };
}

function chatView(state: AgentChatState) {
  return (
    <AgentChatView
      agent="codex"
      agentStatus="working"
      contentInsets={CONTENT_INSETS}
      latestButtonBottom={297}
      onOpenFile={jest.fn()}
      state={state}
    />
  );
}

function flatList(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(node => String(node.type) === 'FlatList');
}

function chatViewport(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(node => node.props.testID === 'agent-chat-viewport');
}

function scrollEvent(offset: number, contentHeight: number, viewportHeight = 400) {
  return {
    nativeEvent: {
      contentOffset: { y: offset },
      contentSize: { height: contentHeight },
      layoutMeasurement: { height: viewportHeight },
    },
  };
}

const TURN: TranscriptTurn = {
  assistants: [],
  diffs: [],
  id: 'turn-1',
  status: 'working',
};

const SHELL_TURN: TranscriptTurn = {
  assistants: [{
    diffs: [],
    id: 'assistant-1',
    parts: [{
      callId: 'call-1',
      id: 'tool-1',
      state: {
        diagnostics: [],
        files: [],
        input: { command: 'printf a-very-long-command-that-exceeds-the-chat-width' },
        loaded: [],
        output: 'a-very-long-output-row-that-also-exceeds-the-chat-width',
        status: 'completed',
      },
      tool: 'shell',
      type: 'tool',
    }],
    role: 'assistant',
  }],
  diffs: [],
  id: 'turn-shell',
  status: 'idle',
};

describe('AgentChatView viewport insets', () => {
  let renderer: ReactTestRenderer;
  let boundaries: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    act(() => boundaries?.unmount());
  });

  test('keeps the viewport edge-to-edge while insetting content and indicators', () => {
    act(() => {
      renderer = create(
        <AgentChatView
          agent="codex"
          agentStatus="idle"
          contentInsets={CONTENT_INSETS}
          latestButtonBottom={297}
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
    expect(list.props.scrollIndicatorInsets).toEqual(CONTENT_INSETS);
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
    expect(spacerHeights).toEqual([16, 210]);

    act(() => {
      list.props.onScroll(scrollEvent(600, 1_000));
      list.props.onScrollBeginDrag(scrollEvent(600, 1_000));
      list.props.onScroll(scrollEvent(0, 1_000));
    });
    const latestButton = renderer.root.find(
      node => node.props.accessibilityLabel === 'Jump to latest',
    );
    expect(latestButton.props.style[0]).toEqual({ bottom: 297 });
  });
});

describe('AgentChatView tool output', () => {
  let renderer: ReactTestRenderer;
  let turnRenderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    act(() => turnRenderer?.unmount());
  });

  test('highlights the shell command and keeps its output horizontally scrollable', () => {
    act(() => {
      renderer = create(chatView(chatState([SHELL_TURN])));
    });
    act(() => {
      turnRenderer = create(flatList(renderer).props.renderItem({
        index: 0,
        item: SHELL_TURN,
      }));
    });

    const toggle = turnRenderer.root.find(node => (
      String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === false
    ));
    act(() => {
      void toggle.props.onPress();
    });

    const expandedToggle = turnRenderer.root.find(node => (
      String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === true
    ));
    const horizontalScroller = turnRenderer.root.find(node => (
      String(node.type) === 'ScrollView' && node.props.horizontal === true
    ));
    const commandHighlighter = turnRenderer.root.find(node => (
      String(node.type) === 'CodeHighlighter'
    ));
    expect(expandedToggle.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    expect(commandHighlighter.props.children).toBe('$ printf a-very-long-command-that-exceeds-the-chat-width');
    expect(commandHighlighter.props.language).toBe('bash');
    expect(commandHighlighter.props.scrollViewProps.nestedScrollEnabled).toBe(true);
    expect(horizontalScroller.props.className).toBe('w-full');
    expect(horizontalScroller.props.nestedScrollEnabled).toBe(true);
  });
});

describe('AgentChatView auto-follow', () => {
  let renderer: ReactTestRenderer;
  let scrollToOffset: jest.Mock;

  beforeEach(() => {
    scrollToOffset = jest.fn();
    act(() => {
      renderer = create(chatView(chatState([TURN])), {
        createNodeMock: element => element.type === 'FlatList'
          ? { scrollToOffset }
          : null,
      });
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
  });

  const establishScrollableContent = (testRenderer: ReactTestRenderer) => {
    act(() => {
      flatList(testRenderer).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      flatList(testRenderer).props.onContentSizeChange(0, 1_000);
      flatList(testRenderer).props.onScroll(scrollEvent(600, 1_000));
    });
  };

  test('starts enabled and follows content-height growth without a new turn', () => {
    establishScrollableContent(renderer);
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 600 });
    scrollToOffset.mockClear();

    act(() => {
      renderer.update(chatView(chatState([{ ...TURN, startedAt: 1 }])));
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });

    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 700 });
  });

  test('keeps following when the user drags against the current end', () => {
    establishScrollableContent(renderer);
    scrollToOffset.mockClear();

    act(() => {
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(600, 1_000));
      flatList(renderer).props.onScroll(scrollEvent(600, 1_000));
    });

    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 700 });
  });

  test('stops following user scroll-up and resumes after the user returns near the end', () => {
    establishScrollableContent(renderer);
    scrollToOffset.mockClear();

    act(() => {
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(600, 1_000));
      flatList(renderer).props.onScroll(scrollEvent(500, 1_000));
    });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(1);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });
    expect(scrollToOffset).not.toHaveBeenCalled();

    act(() => {
      flatList(renderer).props.onScroll(scrollEvent(650, 1_100));
    });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_200);
    });
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 800 });

    scrollToOffset.mockClear();
    act(() => {
      flatList(renderer).props.onScroll(scrollEvent(800, 1_200));
      flatList(renderer).props.onScroll(scrollEvent(750, 1_200));
      flatList(renderer).props.onContentSizeChange(0, 1_300);
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(1);
  });

  test('Latest re-enables follow without treating programmatic momentum as user intent', () => {
    establishScrollableContent(renderer);
    act(() => {
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(600, 1_000));
      flatList(renderer).props.onScroll(scrollEvent(400, 1_000));
    });
    scrollToOffset.mockClear();

    const latestButton = renderer.root.find(
      node => node.props.accessibilityLabel === 'Jump to latest',
    );
    act(() => {
      latestButton.props.onPress();
    });
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: true, offset: 600 });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);

    scrollToOffset.mockClear();
    act(() => {
      flatList(renderer).props.onMomentumScrollBegin();
      flatList(renderer).props.onScroll(scrollEvent(450, 1_000));
      flatList(renderer).props.onMomentumScrollEnd(scrollEvent(450, 1_000));
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });

    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 700 });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);
  });
});

describe('AgentChatView initial viewport readiness', () => {
  let renderer: ReactTestRenderer;
  let scrollToOffset: jest.Mock;
  let nextFrame: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    scrollToOffset = jest.fn();
    nextFrame = 1;
    frames = new Map();
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation(callback => {
      const frame = nextFrame;
      nextFrame += 1;
      frames.set(frame, callback);
      return frame;
    });
    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(frame => {
      frames.delete(frame);
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.restoreAllMocks();
  });

  const flushAnimationFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => callbacks.forEach(callback => callback(0)));
  };

  const renderChat = (state: AgentChatState, onReady: jest.Mock) => {
    act(() => {
      renderer = create(
        <AgentChatView
          agent="codex"
          agentStatus="idle"
          contentInsets={CONTENT_INSETS}
          latestButtonBottom={297}
          onOpenFile={jest.fn()}
          onInitialViewportReady={onReady}
          state={state}
        />,
        {
          createNodeMock: element => element.type === 'FlatList'
            ? { scrollToOffset }
            : null,
        },
      );
    });
  };

  test('signals only after outer layout, content measurement, and the initial bottom pass', () => {
    const onReady = jest.fn();
    renderChat(chatState([TURN]), onReady);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_000);
    });
    flushAnimationFrame();
    flushAnimationFrame();
    expect(onReady).not.toHaveBeenCalled();

    act(() => {
      chatViewport(renderer).props.onLayout({
        nativeEvent: { layout: { height: 400 } },
      });
    });
    expect(scrollToOffset).toHaveBeenLastCalledWith({
      animated: false,
      offset: 600,
    });
    expect(onReady).not.toHaveBeenCalled();

    flushAnimationFrame();
    expect(onReady).not.toHaveBeenCalled();

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });
    expect(scrollToOffset).toHaveBeenLastCalledWith({
      animated: false,
      offset: 700,
    });
    expect(onReady).not.toHaveBeenCalled();

    flushAnimationFrame();
    expect(onReady).not.toHaveBeenCalled();
    flushAnimationFrame();
    expect(onReady).toHaveBeenCalledTimes(1);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_200);
    });
    flushAnimationFrame();
    flushAnimationFrame();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test('an empty loaded transcript can complete initial readiness', () => {
    const onReady = jest.fn();
    renderChat(chatState([]), onReady);

    act(() => {
      chatViewport(renderer).props.onLayout({
        nativeEvent: { layout: { height: 400 } },
      });
      flatList(renderer).props.onContentSizeChange(0, 0);
    });
    flushAnimationFrame();
    flushAnimationFrame();

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
});
