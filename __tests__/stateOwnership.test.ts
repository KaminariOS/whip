jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { setItem: jest.fn() },
}));
jest.mock('expo-localization', () => ({ useLocales: () => [] }));
jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: { changeLanguage: jest.fn(() => Promise.resolve()) },
  languageForLocale: jest.fn(() => 'en'),
}));
jest.mock('../src/services/appLogs', () => ({
  setAppLogCaptureEnabled: jest.fn(),
}));
jest.mock('../src/services/latencyDiagnostics', () => ({
  setLatencyDiagnosticsEnabled: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/terminalBackground', () => ({}));
jest.mock('../src/services/appBackground', () => ({}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearLiveHostLatency,
  recordLiveHostLatency,
  type LiveHostTelemetryState,
} from '../src/hooks/useLiveHostTelemetry';
import { shouldPersistDevicePreferences } from '../src/hooks/useDevicePreferences';
import { updateHostTerminalSessions } from '../src/hooks/useTerminalSessions';
import { PersistedTerminalsWriter } from '../src/services/persistedTerminals';
import {
  persistedLiveHostsFromSessions,
  persistedLiveHostsIdentity,
} from '../src/services/persistedLiveHosts';
import {
  openWorkspaceFromProjection,
  runSemanticHerdrMutation,
  startNativeHerdrServer,
  type SemanticHerdrMutation,
} from '../src/lib/sessionRuntimeActions';
import {
  emptyTerminalSessions,
  openSshShellSession,
} from '../src/terminalSessions';
import { createLiveHostSession } from '../src/liveHostSessions';
import type { HerdrSnapshot, HostProfile, PaneInfo } from '../src/types';

beforeEach(() => {
  jest.clearAllMocks();
});

test('latency changes do not recreate or persist durable terminal metadata', async () => {
  const terminals = openSshShellSession(emptyTerminalSessions);
  const terminalState = updateHostTerminalSessions(
    new Map(),
    'session-1',
    'host-1',
    () => terminals,
  );
  const writer = new PersistedTerminalsWriter();
  writer.observe('session-1', terminals);

  const initialTelemetry: LiveHostTelemetryState = new Map();
  const measured = recordLiveHostLatency(initialTelemetry, 'session-1', 42);
  const cleared = clearLiveHostLatency(measured, 'session-1');

  expect(measured).not.toBe(initialTelemetry);
  expect(cleared).not.toBe(measured);
  expect(terminalState.get('session-1')?.terminals).toBe(terminals);
  await expect(
    writer.saveIfChanged('session-1', 'host-1', terminals),
  ).resolves.toBe(false);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

test('terminal persistence runs when durable terminal metadata changes', async () => {
  const writer = new PersistedTerminalsWriter();
  writer.observe('session-1', emptyTerminalSessions);
  const terminals = {
    activeTerminalId: 'terminal-1',
    sessions: [
      {
        terminalId: 'terminal-1',
        paneId: 'pane-1',
        title: 'Agent',
        kind: 'herdr' as const,
        status: 'connected' as const,
        reconnectAttempt: 0,
      },
    ],
  };

  await expect(
    writer.saveIfChanged('session-1', 'host-1', terminals),
  ).resolves.toBe(true);
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
});

test('preferences cannot persist while loading, failed, or merely hydrated', () => {
  expect(shouldPersistDevicePreferences({ status: 'loading' }, 1)).toBe(false);
  expect(
    shouldPersistDevicePreferences(
      { status: 'failed', error: new Error('I/O') },
      2,
    ),
  ).toBe(false);
  expect(shouldPersistDevicePreferences({ status: 'loaded' }, 0)).toBe(false);
  expect(shouldPersistDevicePreferences({ status: 'loaded' }, 1)).toBe(true);
});

test('volatile host projection changes keep the durable live-host identity stable', () => {
  const host: HostProfile = {
    id: 'host-1',
    name: 'Host 1',
    host: 'host-1.example.test',
    port: '22',
    username: 'herdr',
    authMode: 'key',
    herdrCommand: 'herdr',
    sessionName: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const session = createLiveHostSession(host, 'session-1');
  const first = {
    activeSessionId: 'session-1',
    sessions: [session],
  };
  const hostStateChanged = {
    ...first,
    sessions: [
      {
        ...session,
        sync: { ...session.sync, revision: 2 },
      },
    ],
  };

  expect(
    persistedLiveHostsIdentity(
      persistedLiveHostsFromSessions(hostStateChanged),
    ),
  ).toBe(persistedLiveHostsIdentity(persistedLiveHostsFromSessions(first)));
});

describe('native-owned Herdr actions', () => {
  const client = () => ({
    closeTab: jest.fn(async () => undefined),
    closeWorkspace: jest.fn(async () => undefined),
    focusWorkspace: jest.fn(async () => undefined),
    refreshHostState: jest.fn(async () => undefined),
    renameWorkspace: jest.fn(async () => undefined),
    startServer: jest.fn(async () => undefined),
  });

  test.each<{
    mutation: SemanticHerdrMutation;
    method: 'closeTab' | 'closeWorkspace' | 'renameWorkspace';
    args: string[];
  }>([
    {
      mutation: {
        type: 'rename-workspace',
        workspaceId: 'space-1',
        name: 'Renamed',
      },
      method: 'renameWorkspace',
      args: ['space-1', 'Renamed'],
    },
    {
      mutation: { type: 'close-workspace', workspaceId: 'space-1' },
      method: 'closeWorkspace',
      args: ['space-1'],
    },
    {
      mutation: { type: 'close-tab', tabId: 'tab-1' },
      method: 'closeTab',
      args: ['tab-1'],
    },
  ])(
    '$mutation.type issues one semantic mutation without a snapshot refresh',
    async ({ args, method, mutation }) => {
      const runtime = client();

      await runSemanticHerdrMutation(runtime, mutation);

      expect(runtime[method]).toHaveBeenCalledTimes(1);
      expect(runtime[method]).toHaveBeenCalledWith(...args);
      expect(runtime.refreshHostState).not.toHaveBeenCalled();
    },
  );

  test('server startup delegates readiness to native state events', async () => {
    const runtime = client();

    await startNativeHerdrServer(runtime);

    expect(runtime.startServer).toHaveBeenCalledTimes(1);
    expect(runtime.refreshHostState).not.toHaveBeenCalled();
  });

  test('a populated workspace opens through the navigation-aware pane path', async () => {
    const runtime = client();
    const pane = testPane();
    const openPaneTerminal = jest.fn();
    const activatePaneTerminal = jest.fn();
    const refreshSnapshot = jest.fn(async () => null);
    const selectTerminal = jest.fn();
    const selectWorkspace = jest.fn();

    await openWorkspaceFromProjection({
      activatePaneTerminal,
      client: runtime,
      emptyWorkspaceError: () => new Error('empty'),
      openPaneTerminal,
      refreshSnapshot,
      selectTerminal,
      selectWorkspace,
      snapshot: testSnapshot(pane),
      workspaceId: pane.workspace_id,
    });

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(openPaneTerminal).toHaveBeenCalledWith(pane);
    expect(runtime.focusWorkspace).not.toHaveBeenCalled();
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect(selectTerminal).not.toHaveBeenCalled();
    expect(activatePaneTerminal).not.toHaveBeenCalled();
  });

  test('an initially empty workspace opens the pane from the explicit native projection', async () => {
    const runtime = client();
    const pane = testPane();
    const activatePaneTerminal = jest.fn();
    const refreshSnapshot = jest.fn(async () => testSnapshot(pane));

    await openWorkspaceFromProjection({
      activatePaneTerminal,
      client: runtime,
      emptyWorkspaceError: () => new Error('empty'),
      openPaneTerminal: jest.fn(),
      refreshSnapshot,
      selectTerminal: jest.fn(),
      selectWorkspace: jest.fn(),
      snapshot: testSnapshot(),
      workspaceId: pane.workspace_id,
    });

    expect(runtime.focusWorkspace).toHaveBeenCalledWith(pane.workspace_id);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(activatePaneTerminal).toHaveBeenCalledWith(pane);
  });
});

function testPane(): PaneInfo {
  return {
    pane_id: 'pane-1',
    terminal_id: 'terminal-1',
    tab_id: 'tab-1',
    workspace_id: 'space-1',
    focused: true,
    revision: 1,
    agent_status: 'idle',
  };
}

function testSnapshot(pane?: PaneInfo): HerdrSnapshot {
  return {
    server: { running: true },
    focused_workspace_id: pane?.workspace_id ?? null,
    focused_tab_id: pane?.tab_id ?? null,
    focused_pane_id: pane?.pane_id ?? null,
    agents: [],
    workspaces: pane
      ? [
          {
            workspace_id: pane.workspace_id,
            number: 1,
            label: 'Workspace',
            focused: true,
            pane_count: 1,
            tab_count: 1,
            active_tab_id: pane.tab_id,
            agent_status: 'idle',
          },
        ]
      : [],
    tabs: pane
      ? [
          {
            tab_id: pane.tab_id,
            workspace_id: pane.workspace_id,
            number: 1,
            label: 'Tab',
            focused: true,
            pane_count: 1,
            agent_status: 'idle',
          },
        ]
      : [],
    panes: pane ? [pane] : [],
    layouts: [],
  };
}
