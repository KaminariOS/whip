import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { resolveHerdProjectionRequest } from '../src/herdQueue';
import {
  useAppNavigation,
  type AppNavigationController,
} from '../src/hooks/useAppNavigation';

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

interface TestAgent {
  hostId: string;
  workspaceId: string;
}

interface TestHost {
  id: string;
  workspaceIds: string[];
  agents: TestAgent[];
}

interface TestProjection {
  selectedHostId?: string;
  selectedWorkspaceId?: string;
  agents: TestAgent[];
}

function nativeHerdView(hosts: TestHost[]) {
  return jest.fn((
    _metadata: { sessionId: string }[],
    requestedHostId?: string,
    requestedWorkspaceId?: string,
  ): TestProjection => {
    const selectedHostId = hosts.length === 1
      ? hosts[0].id
      : requestedHostId && hosts.some(host => host.id === requestedHostId)
        ? requestedHostId
        : undefined;
    const selectedHost = hosts.find(host => host.id === selectedHostId);
    const selectedWorkspaceId = selectedHost?.workspaceIds.length === 1
      ? selectedHost.workspaceIds[0]
      : requestedWorkspaceId
        && selectedHost?.workspaceIds.includes(requestedWorkspaceId)
        ? requestedWorkspaceId
        : undefined;
    const scopedHosts = selectedHost ? [selectedHost] : hosts;

    return {
      selectedHostId,
      selectedWorkspaceId,
      agents: scopedHosts.flatMap(host => host.agents).filter(agent =>
        !selectedWorkspaceId || agent.workspaceId === selectedWorkspaceId,
      ),
    };
  });
}

let navigation: AppNavigationController | null = null;
let projection: TestProjection | null = null;

function ProjectionHarness({
  hosts,
  herdView,
}: {
  hosts: TestHost[];
  herdView: ReturnType<typeof nativeHerdView>;
}) {
  navigation = useAppNavigation({
    appReady: true,
    preferencesLoaded: true,
    preferredTab: 'herd',
    recordLastTab: jest.fn(),
    dismissTopOverlay: () => false,
  });
  const request = resolveHerdProjectionRequest(
    hosts.map(host => host.id),
    navigation.herdHostFilterId,
    navigation.herdWorkspaceFilterIds,
  );
  projection = herdView(
    hosts.map(host => ({ sessionId: host.id })),
    request.hostId ?? undefined,
    request.workspaceId ?? undefined,
  );
  return null;
}

const host = (id: string, workspaceIds: string[]): TestHost => ({
  id,
  workspaceIds,
  agents: workspaceIds.map(workspaceId => ({ hostId: id, workspaceId })),
});

describe('Herd navigation to Rust projection round trip', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    navigation = null;
    projection = null;
    jest.clearAllMocks();
  });

  test('keeps a workspace selection when Rust auto-selects the only host', () => {
    const herdView = nativeHerdView([
      host('host-1', ['space-a', 'space-b']),
    ]);
    act(() => {
      renderer = create(<ProjectionHarness
        hosts={[host('host-1', ['space-a', 'space-b'])]}
        herdView={herdView}
      />);
    });
    herdView.mockClear();

    act(() => navigation?.setHerdWorkspaceFilter('host-1', 'space-b'));

    expect(navigation?.herdHostFilterId).toBeNull();
    expect(navigation?.herdWorkspaceFilterIds).toEqual({ 'host-1': 'space-b' });
    expect(herdView).toHaveBeenCalledWith(
      [{ sessionId: 'host-1' }],
      'host-1',
      'space-b',
    );
    expect(projection).toEqual(expect.objectContaining({
      selectedHostId: 'host-1',
      selectedWorkspaceId: 'space-b',
      agents: [{ hostId: 'host-1', workspaceId: 'space-b' }],
    }));
  });

  test('preserves Rust single-workspace auto-selection', () => {
    const hosts = [host('host-1', ['only-space'])];
    const herdView = nativeHerdView(hosts);
    act(() => {
      renderer = create(<ProjectionHarness hosts={hosts} herdView={herdView} />);
    });

    expect(herdView).toHaveBeenLastCalledWith(
      [{ sessionId: 'host-1' }],
      'host-1',
      undefined,
    );
    expect(projection?.selectedWorkspaceId).toBe('only-space');
  });

  test('does not apply one host workspace filter to another host', () => {
    const hosts = [
      host('host-1', ['space-a', 'space-b']),
      host('host-2', ['space-c', 'space-d']),
    ];
    const herdView = nativeHerdView(hosts);
    act(() => {
      renderer = create(<ProjectionHarness hosts={hosts} herdView={herdView} />);
    });
    act(() => navigation?.setHerdWorkspaceFilter('host-1', 'space-b'));
    herdView.mockClear();

    act(() => navigation?.selectHerdHost('host-2'));

    expect(herdView).toHaveBeenCalledWith(
      [{ sessionId: 'host-1' }, { sessionId: 'host-2' }],
      'host-2',
      undefined,
    );
    expect(projection).toEqual(expect.objectContaining({
      selectedHostId: 'host-2',
      selectedWorkspaceId: undefined,
      agents: [
        { hostId: 'host-2', workspaceId: 'space-c' },
        { hostId: 'host-2', workspaceId: 'space-d' },
      ],
    }));
  });

  test('All Spaces clears the workspace request and restores host agents', () => {
    const hosts = [host('host-1', ['space-a', 'space-b'])];
    const herdView = nativeHerdView(hosts);
    act(() => {
      renderer = create(<ProjectionHarness hosts={hosts} herdView={herdView} />);
    });
    act(() => navigation?.setHerdWorkspaceFilter('host-1', 'space-b'));
    herdView.mockClear();

    act(() => navigation?.setHerdWorkspaceFilter('host-1', null));

    expect(navigation?.herdWorkspaceFilterIds).toEqual({ 'host-1': null });
    expect(herdView).toHaveBeenCalledWith(
      [{ sessionId: 'host-1' }],
      'host-1',
      undefined,
    );
    expect(projection).toEqual(expect.objectContaining({
      selectedHostId: 'host-1',
      selectedWorkspaceId: undefined,
      agents: [
        { hostId: 'host-1', workspaceId: 'space-a' },
        { hostId: 'host-1', workspaceId: 'space-b' },
      ],
    }));
  });
});
