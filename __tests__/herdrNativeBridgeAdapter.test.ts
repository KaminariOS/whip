jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => ({
  closeHerdrEventSubscription: jest.fn(),
  closeAllHerdrTerminalBridges: jest.fn(),
  closeHerdrTerminalBridge: jest.fn(),
  herdrTerminalInput: jest.fn(),
  herdrTerminalResize: jest.fn(),
  herdrTerminalScroll: jest.fn(),
  herdrControlRequest: jest.fn().mockResolvedValue({ tag: 'Ok' }),
  createHostRuntime: jest.fn(),
  AgentTranscriptKind: { Codex: 0, OpenCode: 1 },
  AgentTranscriptStatus: { Loading: 0, Live: 1, Stale: 2, Unavailable: 3, Error: 4, Closed: 5 },
  AgentMessageRole: { User: 0, Assistant: 1 },
  AgentToolStatus: { Pending: 0, Running: 1, Completed: 2, Error: 3 },
  AgentNoticeLevel: { Info: 0, Warning: 1, Error: 2 },
  AgentTurnStatus: { Idle: 0, Working: 1, Interrupted: 2, Error: 3 },
  AgentScalarValue_Tags: { String: 'String', Number: 'Number', Boolean: 'Boolean' },
  AgentTranscriptPart_Tags: {
    Text: 'Text', Reasoning: 'Reasoning', Tool: 'Tool', Plan: 'Plan', Notice: 'Notice',
  },
  AgentTranscriptDelta_Tags: {
    Reset: 'Reset', InfoChanged: 'InfoChanged', MessageUpserted: 'MessageUpserted',
    MessageRemoved: 'MessageRemoved', MessagesTruncated: 'MessagesTruncated',
    TurnUpserted: 'TurnUpserted', TurnsTruncated: 'TurnsTruncated', StatusChanged: 'StatusChanged',
  },
  HostSshCredential: {
    Password: { new: jest.fn(inner => ({ tag: 'Password', inner })) },
    Key: { new: jest.fn(inner => ({ tag: 'Key', inner })) },
  },
  HostRuntimeEvent_Tags: {
    ConnectionStateChanged: 'ConnectionStateChanged',
    ReconnectScheduled: 'ReconnectScheduled',
    Reconnected: 'Reconnected',
    TerminalStateChanged: 'TerminalStateChanged',
    HostStateChanged: 'HostStateChanged',
    Herdr: 'Herdr',
    EventSubscriptionClosed: 'EventSubscriptionClosed',
    EventSubscriptionRestored: 'EventSubscriptionRestored',
    FatalError: 'FatalError',
  },
  HerdrControlRequest: {
    WorkspaceFocus: { new: jest.fn(inner => ({ tag: 'WorkspaceFocus', inner })) },
    AgentFocus: { new: jest.fn(inner => ({ tag: 'AgentFocus', inner })) },
  },
  HerdrControlResult_Tags: {
    Pong: 'Pong', SessionSnapshot: 'SessionSnapshot', WorkspaceCreated: 'WorkspaceCreated',
    WorkspaceInfo: 'WorkspaceInfo', TabCreated: 'TabCreated', TabInfo: 'TabInfo',
    PaneInfo: 'PaneInfo', PaneRead: 'PaneRead', AgentStarted: 'AgentStarted',
    AgentInfo: 'AgentInfo', AgentPrompted: 'AgentPrompted', PaneZoom: 'PaneZoom', Ok: 'Ok',
  },
  HerdrAgentSessionKind: { Id: 0, Path: 1 },
  HerdrAgentStatus: { Idle: 0, Working: 1, Blocked: 2, Done: 3, Unknown: 4 },
  HostSyncStatus: { Idle: 0, Syncing: 1, Synced: 2, Error: 3 },
  HostFreshness: { Loading: 0, Fresh: 1, Stale: 2, Unavailable: 3 },
  HostConnectionState: {
    Disconnected: 0, Connecting: 1, Connected: 2, Reconnecting: 3, Disconnecting: 4, Failed: 5,
  },
  HostTerminalState: { Opening: 0, Attached: 1, Restoring: 2, Closed: 3, Failed: 4 },
  HerdrSplitDirection: { Right: 0, Down: 1 },
  HerdrTerminalAttachLaunchMode: { LegacyTerminalAttach: 0, TerminalAttach: 1 },
  HerdrTerminalNotificationKind: { Sound: 0, Toast: 1, SystemToast: 2 },
  HerdrTerminalControlEvent_Tags: {
    Closed: 'Closed', Notify: 'Notify', Clipboard: 'Clipboard', Title: 'Title',
    ReloadSoundConfig: 'ReloadSoundConfig', MouseCapture: 'MouseCapture',
    KittyKeyboardReportAll: 'KittyKeyboardReportAll', PrefixInputSource: 'PrefixInputSource',
    TerminalBell: 'TerminalBell', Ignored: 'Ignored',
  },
  HerdrEvent_Tags: {
    WorkspaceCreated: 'WorkspaceCreated', WorkspaceUpdated: 'WorkspaceUpdated',
    WorkspaceMetadataUpdated: 'WorkspaceMetadataUpdated', WorkspaceClosed: 'WorkspaceClosed',
    WorkspaceRenamed: 'WorkspaceRenamed', WorkspaceMoved: 'WorkspaceMoved',
    WorkspaceReordered: 'WorkspaceReordered', WorkspaceFocused: 'WorkspaceFocused',
    WorktreeCreated: 'WorktreeCreated', WorktreeOpened: 'WorktreeOpened',
    WorktreeRemoved: 'WorktreeRemoved', TabCreated: 'TabCreated', TabClosed: 'TabClosed',
    TabFocused: 'TabFocused', TabRenamed: 'TabRenamed', TabMoved: 'TabMoved',
    PaneCreated: 'PaneCreated', PaneUpdated: 'PaneUpdated', PaneClosed: 'PaneClosed',
    PaneFocused: 'PaneFocused', PaneExited: 'PaneExited', PaneMoved: 'PaneMoved',
    PaneOutputChanged: 'PaneOutputChanged', PaneAgentDetected: 'PaneAgentDetected',
    PaneAgentStatusChanged: 'PaneAgentStatusChanged', LayoutUpdated: 'LayoutUpdated',
    ProtocolUnknown: 'ProtocolUnknown', ProtocolInvalid: 'ProtocolInvalid',
  },
  pairHost: jest.fn(),
  prepareHerdrTerminalBridge: jest.fn().mockResolvedValue(undefined),
  setHerdrEventSink: jest.fn(),
  setAgentTranscriptEventSink: jest.fn(),
  setHerdrTerminalEventSink: jest.fn(),
  setHostRuntimeEventSink: jest.fn(),
  startHerdrEventSubscription: jest.fn().mockResolvedValue(undefined),
  startHerdrTerminalBridge: jest.fn().mockResolvedValue(undefined),
}));

import nativeClient from '../packages/react-native-whip-ssh/src';

const mockGenerated = jest.requireMock(
  '../packages/react-native-whip-ssh/src/generated-entry',
);
const mockEventSink = mockGenerated.setHerdrTerminalEventSink.mock.calls[0][0];
const mockApiEventSink = mockGenerated.setHerdrEventSink.mock.calls[0][0];
const mockRuntimeEventSink = mockGenerated.setHostRuntimeEventSink.mock.calls[0][0];
const mockAgentEventSink = mockGenerated.setAgentTranscriptEventSink.mock.calls[0][0];

describe('native Herdr bridge adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards native binary frames without string, base64, or JSON conversion', async () => {
    const handler = jest.fn();
    await nativeClient.startHerdrBridge(
      'client-1',
      '/tmp/herdr.sock',
      20,
      'terminal-1',
      true,
      80,
      24,
      8,
      16,
      1,
      handler,
    );

    const payload = Uint8Array.from([0, 0xff, 0x80, 0x1b]).buffer;
    mockEventSink.terminalFrame('client-1', 'terminal-1', 42n, 80, 24, true, payload);

    expect(handler).toHaveBeenCalledWith({
      type: 'terminal',
      terminalId: 'terminal-1',
      seq: 42,
      width: 80,
      height: 24,
      full: true,
      bytes: payload,
      final: true,
      inboundTraceCookie: null,
    });
    expect(handler.mock.calls[0][0].bytes).toBe(payload);
  });

  it('maps typed native control records to the existing public event shape', async () => {
    const handler = jest.fn();
    await nativeClient.startHerdrBridge(
      'client-1',
      '/tmp/herdr.sock',
      17,
      'terminal-1',
      false,
      80,
      24,
      0,
      0,
      1,
      handler,
    );

    mockEventSink.control('client-1', 'terminal-1', {
      tag: 'Notify',
      inner: { kind: 2, text: 'done', body: 'body' },
    });

    expect(handler).toHaveBeenCalledWith({
      type: 'notify',
      terminalId: 'terminal-1',
      text: 'done',
      body: 'body',
      kind: 2,
    });
  });

  it('sends semantic control requests and returns typed native results', async () => {
    mockGenerated.herdrControlRequest.mockResolvedValueOnce({ tag: 'Ok' });

    await expect(nativeClient.requestHerdrApi(
      'client-1',
      '/tmp/herdr.sock',
      { method: 'workspace.focus', params: { workspace_id: 'w1' } },
    )).resolves.toEqual({ type: 'ok' });

    expect(mockGenerated.herdrControlRequest).toHaveBeenCalledWith(
      'client-1',
      '/tmp/herdr.sock',
      { tag: 'WorkspaceFocus', inner: { workspaceId: 'w1' } },
    );

    await nativeClient.requestHerdrApi(
      'client-1', '/tmp/herdr.sock', { method: 'agent.focus', params: { target: 'codex-1' } },
    );
    expect(mockGenerated.herdrControlRequest).toHaveBeenLastCalledWith(
      'client-1', '/tmp/herdr.sock', { tag: 'AgentFocus', inner: { target: 'codex-1' } },
    );
  });

  it('forwards typed native API events without exposing JSON envelopes', async () => {
    const handler = jest.fn();
    await nativeClient.startHerdrEventStream(
      'client-1', '/tmp/herdr.sock', 20, ['p1'], handler,
    );

    mockApiEventSink.event('client-1', {
      tag: 'PaneFocused',
      inner: { workspaceId: 'w1', paneId: 'p1' },
    });

    expect(handler).toHaveBeenCalledWith({
      type: 'event',
      event: {
        event: 'pane.focused',
        data: { workspace_id: 'w1', pane_id: 'p1' },
      },
    });
    expect(mockGenerated.startHerdrEventSubscription).toHaveBeenCalledWith(
      'client-1', '/tmp/herdr.sock', 20, ['p1'],
    );
  });

  it('exposes semantic HostRuntime operations and typed lifecycle events', async () => {
    const nativeState = {
      revision: 7n,
      connectionGeneration: 3n,
      syncGeneration: 2n,
      syncStatus: 2,
      freshness: 1,
      lastSyncedAtMs: 1234n,
      needsResync: false,
      focus: { workspaceId: 'w1', tabId: 't1', paneId: 'p1' },
    };
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-1'),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      controlRequest: jest.fn().mockResolvedValue({ tag: 'Ok' }),
      resolveControlSocket: jest.fn().mockResolvedValue('/tmp/herdr.sock'),
      hostState: jest.fn(() => nativeState),
      refreshState: jest.fn().mockResolvedValue(nativeState),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const handler = jest.fn();
    const runtime = nativeClient.createHostRuntime({
      runtimeId: 'runtime-1',
      ssh: {
        host: 'host.test', port: 22, username: 'me', authMode: 'password', secret: 'secret',
      },
      jumpHosts: [],
      sessionName: 'main',
    }, handler);

    await runtime.connect();
    await expect(runtime.resolveHerdrSocketPath()).resolves.toBe('/tmp/herdr.sock');
    await expect(runtime.requestHerdrApi({
      method: 'workspace.focus', params: { workspace_id: 'w1' },
    })).resolves.toEqual({ type: 'ok' });
    mockRuntimeEventSink.event({
      tag: 'ConnectionStateChanged',
      inner: {
        runtimeId: 'runtime-1',
        status: { state: mockGenerated.HostConnectionState.Connected, generation: 3n, reconnectAttempt: 0 },
      },
    });
    mockRuntimeEventSink.event({
      tag: 'TerminalStateChanged',
      inner: {
        runtimeId: 'runtime-1', terminalId: 'terminal-1', state: mockGenerated.HostTerminalState.Restoring,
        reconnectAttempt: 2n, retrying: true, error: 'channel closed',
      },
    });
    mockRuntimeEventSink.event({
      tag: 'HostStateChanged',
      inner: {
        runtimeId: 'runtime-1',
        state: nativeState,
        changedAgentPaneIds: ['p1'],
      },
    });

    expect(rustRuntime.connect).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenNthCalledWith(1, {
      type: 'connection-state', state: 'connected', generation: 3,
      reconnectAttempt: 0, error: undefined,
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      type: 'terminal-state', terminalId: 'terminal-1', state: 'restoring',
      reconnectAttempt: 2, retrying: true, error: 'channel closed',
    });
    expect(runtime.hostState()).toEqual({
      revision: 7,
      connectionGeneration: 3,
      syncGeneration: 2,
      syncStatus: 'synced',
      freshness: 'fresh',
      error: undefined,
      lastSyncedAtMs: 1234,
      lastEventAtMs: undefined,
      needsResync: false,
      focus: { workspaceId: 'w1', tabId: 't1', paneId: 'p1' },
      snapshot: undefined,
    });
    expect(handler).toHaveBeenNthCalledWith(3, {
      type: 'host-state',
      state: runtime.hostState(),
      changedAgentPaneIds: ['p1'],
    });

    for (const [state, expected] of [
      [mockGenerated.HostConnectionState.Disconnected, 'disconnected'],
      [mockGenerated.HostConnectionState.Connecting, 'connecting'],
      [mockGenerated.HostConnectionState.Connected, 'connected'],
      [mockGenerated.HostConnectionState.Reconnecting, 'reconnecting'],
      [mockGenerated.HostConnectionState.Disconnecting, 'disconnecting'],
      [mockGenerated.HostConnectionState.Failed, 'failed'],
    ] as const) {
      mockRuntimeEventSink.event({
        tag: 'ConnectionStateChanged',
        inner: {
          runtimeId: 'runtime-1',
          status: { state, generation: 4n, reconnectAttempt: 1 },
        },
      });
      expect(handler).toHaveBeenLastCalledWith({
        type: 'connection-state', state: expected, generation: 4,
        reconnectAttempt: 1, error: undefined,
      });
    }

    for (const [state, expected] of [
      [mockGenerated.HostTerminalState.Opening, 'opening'],
      [mockGenerated.HostTerminalState.Attached, 'attached'],
      [mockGenerated.HostTerminalState.Restoring, 'restoring'],
      [mockGenerated.HostTerminalState.Closed, 'closed'],
      [mockGenerated.HostTerminalState.Failed, 'failed'],
    ] as const) {
      mockRuntimeEventSink.event({
        tag: 'TerminalStateChanged',
        inner: {
          runtimeId: 'runtime-1', terminalId: 'terminal-1', state,
          reconnectAttempt: 1n, retrying: true,
        },
      });
      expect(handler).toHaveBeenLastCalledWith({
        type: 'terminal-state', terminalId: 'terminal-1', state: expected,
        reconnectAttempt: 1, retrying: true, error: undefined,
      });
    }
  });

  it('logs and unwraps typed HostRuntime connection failures', async () => {
    const nativeError = {
      tag: 'SshTransportFailure',
      inner: ['SSH key exchange failed'],
    };
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-failing'),
      connect: jest.fn().mockRejectedValue(nativeError),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const runtime = nativeClient.createHostRuntime({
      runtimeId: 'runtime-failing',
      ssh: {
        host: 'host.test', port: 22, username: 'me', authMode: 'password', secret: 'secret',
      },
      jumpHosts: [], sessionName: 'main',
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runtime.connect()).rejects.toMatchObject({
      name: 'HostRuntimeError',
      message: 'SSH key exchange failed',
      nativeTag: 'SshTransportFailure',
    });
    expect(consoleError).toHaveBeenCalledWith('[WhipSsh] host runtime connect failed', {
      runtimeId: 'runtime-failing',
      tag: 'SshTransportFailure',
      message: 'SSH key exchange failed',
    });
    consoleError.mockRestore();
  });

  it('projects typed native transcript snapshots and callbacks without JSON', () => {
    const nativeState = {
      sessionId: 'session-1', agent: 0, revision: 4n, status: 1,
      messages: [{
        id: 'assistant:1', role: 1,
        parts: [{ tag: 'Text', inner: { id: 'text:1', text: 'hello', timestampMs: 12n } }],
        diffs: [],
      }],
      turns: [{
        id: 'turn:1', assistantMessageIds: ['assistant:1'], status: 0, diffs: [],
      }],
    };
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-agent'),
      openAgentSession: jest.fn(() => ({ key: 'codex:session-1', state: nativeState })),
      bindAgentSession: jest.fn(() => ({ key: 'codex:session-1', state: nativeState })),
      startAgentSession: jest.fn(() => nativeState),
      agentTranscript: jest.fn(() => nativeState),
      closeAgentSession: jest.fn(),
      closeAgentTerminal: jest.fn(),
      confirmAgentTranscriptCache: jest.fn(() => true),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const runtime = nativeClient.createHostRuntime({
      runtimeId: 'runtime-agent',
      ssh: {
        host: 'host.test', port: 22, username: 'me', authMode: 'password', secret: 'secret',
      },
      jumpHosts: [], sessionName: 'main',
    });
    const handler = jest.fn();
    const result = runtime.openAgentSession('codex', 'terminal-1', 'session-1', undefined, handler);
    const bound = runtime.bindAgentSession('codex', 'terminal-1', 'session-1', handler);
    const started = runtime.startAgentSession('terminal-1', bound.key);

    expect(result.state).toEqual(expect.objectContaining({
      sessionId: 'session-1', revision: 4, status: 'live',
      messages: [expect.objectContaining({
        id: 'assistant:1', role: 'assistant',
        parts: [{ type: 'text', id: 'text:1', text: 'hello', timestamp: 12 }],
      })],
    }));
    expect(started).toEqual(expect.objectContaining({ revision: 4, status: 'live' }));
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent', key: 'codex:session-1',
      update: { revision: 4n, deltas: [{ tag: 'Reset', inner: { state: nativeState } }] },
      cacheWrite: {
        key: 'cache', blob: new Uint8Array([1, 2]).buffer, confirmationToken: 'token',
        revision: 4n, sourceGeneration: 2n, position: 100n,
      },
    });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      key: 'codex:session-1',
      revision: 4,
      deltas: [{ type: 'reset', state: expect.objectContaining({ revision: 4 }) }],
      cacheWrite: expect.objectContaining({ confirmationToken: 'token' }),
    }));
    handler.mockClear();
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent', key: 'codex:session-1', cacheWrite: undefined,
      update: {
        revision: 5n,
        deltas: [{ tag: 'StatusChanged', inner: { status: 5, error: undefined } }],
      },
    });
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent', key: 'codex:session-1', cacheWrite: undefined,
      update: { revision: 6n, deltas: [] },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
