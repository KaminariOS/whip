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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  emptyTerminalSessions,
  openSshShellSession,
} from '../src/terminalSessions';
import type { LiveHostSessionsState } from '../src/liveHostSessions';

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
  const session = {
    id: 'session-1',
    hostId: 'host-1',
    snapshot: { revision: 1 },
  };
  const first = {
    activeSessionId: 'session-1',
    sessions: [session],
  } as unknown as LiveHostSessionsState;
  const hostStateChanged = {
    ...first,
    sessions: [{ ...session, snapshot: { revision: 2 } }],
  } as unknown as LiveHostSessionsState;

  expect(
    persistedLiveHostsIdentity(
      persistedLiveHostsFromSessions(hostStateChanged),
    ),
  ).toBe(persistedLiveHostsIdentity(persistedLiveHostsFromSessions(first)));
});

test('App remains a composition root instead of reclaiming runtime ownership', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');

  expect(app.split('\n').length).toBeLessThan(600);
  expect(app).toContain('useSessionRuntimeManager');
  expect(app).toContain('useHostManagement');
  expect(app).toContain('useAppNavigation');
  expect(app).toContain('<AppShell');
  expect(app).not.toContain('new HerdrClient');
  expect(app).not.toContain('setRuntimeEventHandler');
  expect(app).not.toContain('retainedBackgroundRuntimes');
});

test('semantic Herdr mutation callers do not append JavaScript snapshot refreshes', () => {
  const manager = readFileSync(
    join(__dirname, '..', 'src/hooks/useSessionRuntimeManager.ts'),
    'utf8',
  );
  const sessionScreen = readFileSync(
    join(__dirname, '..', 'src/components/SessionScreen.tsx'),
    'utf8',
  );
  const paneDetail = readFileSync(
    join(__dirname, '..', 'src/components/PaneDetail.tsx'),
    'utf8',
  );

  expect(manager).not.toMatch(/client\.renameWorkspace\([^;]+;\s*await refresh/);
  expect(manager).not.toMatch(/client\.closeWorkspace\([^;]+;\s*await refresh/);
  expect(manager).not.toMatch(/client\.closeTab\([^;]+;\s*await refresh/);
  expect(manager).not.toMatch(/client\.focus(?:Agent|Pane)\([^;]+[\s\S]{0,80}refresh\(/);
  expect(sessionScreen).not.toContain('if (refresh) await onRefresh()');
  expect(paneDetail).not.toContain('onChanged');
});

test('Herdr startup readiness is entirely native-owned', () => {
  const manager = readFileSync(
    join(__dirname, '..', 'src/hooks/useSessionRuntimeManager.ts'),
    'utf8',
  );
  const startServer = manager.slice(
    manager.indexOf('const startServer = useCallback'),
    manager.indexOf('const terminalTargets = useMemo'),
  );

  expect(startServer).toContain('await runtime.client.startServer()');
  expect(startServer).not.toContain('setTimeout');
  expect(startServer).not.toMatch(/\brefresh\s*\(/);
  expect(startServer).not.toContain('refreshSnapshot');
  expect(startServer).not.toContain('session.snapshot');
});

test('opening a populated Herd workspace uses the navigation-aware terminal path', () => {
  const manager = readFileSync(
    join(__dirname, '..', 'src/hooks/useSessionRuntimeManager.ts'),
    'utf8',
  );
  const openWorkspace = manager.slice(
    manager.indexOf('const openWorkspace = useCallback'),
    manager.indexOf('const createWorkspace = useCallback'),
  );

  expect(openWorkspace).toMatch(/if \(pane\) \{\s*openPaneTerminal\(sessionId, pane\);/);
  expect(openWorkspace).not.toContain('terminals.openPane(sessionId, pane)');
});
