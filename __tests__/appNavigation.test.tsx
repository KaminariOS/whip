import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  useAppNavigation,
  type AppNavigationController,
} from '../src/hooks/useAppNavigation';
import { beginAppPerformanceTrace } from '../src/services/performanceTrace';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  BackHandler: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
jest.mock('../src/services/performanceTrace', () => ({
  beginAppPerformanceTrace: jest.fn(() => null),
  endAppPerformanceTrace: jest.fn(),
}));

let navigation: AppNavigationController | null = null;

function NavigationHarness({
  onFirstTabMounted,
}: {
  onFirstTabMounted: () => void;
}) {
  navigation = useAppNavigation({
    appReady: true,
    preferencesLoaded: true,
    preferredTab: 'hosts',
    recordLastTab: jest.fn(),
    dismissTopOverlay: () => false,
    onFirstTabMounted,
  });
  return null;
}

describe('useAppNavigation', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    navigation = null;
    jest.clearAllMocks();
  });

  test('notifies once after the first tab mounts when performance tracing is disabled', () => {
    const onFirstTabMounted = jest.fn();

    act(() => {
      renderer = create(
        <NavigationHarness onFirstTabMounted={onFirstTabMounted} />,
      );
    });

    expect(beginAppPerformanceTrace).toHaveReturnedWith(null);
    expect(navigation?.mountedTabs.has('hosts')).toBe(true);
    expect(onFirstTabMounted).toHaveBeenCalledTimes(1);

    act(() => navigation?.selectTab('herd'));

    expect(navigation?.mountedTabs.has('herd')).toBe(true);
    expect(onFirstTabMounted).toHaveBeenCalledTimes(1);
  });
});
