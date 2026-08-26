jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => ({
  closeHerdrEventSubscription: jest.fn(),
  closeAllHerdrTerminalBridges: jest.fn(),
  closeHerdrTerminalBridge: jest.fn(),
  herdrTerminalInput: jest.fn(),
  herdrTerminalResize: jest.fn(),
  herdrTerminalScroll: jest.fn(),
  herdrControlRequest: jest.fn().mockResolvedValue({ kind: 'ok' }),
  HerdrControlRequest: {
    WorkspaceFocus: { new: jest.fn(inner => ({ tag: 'WorkspaceFocus', inner })) },
    AgentFocus: { new: jest.fn(inner => ({ tag: 'AgentFocus', inner })) },
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
  setHerdrTerminalEventSink: jest.fn(),
  startHerdrEventSubscription: jest.fn().mockResolvedValue(undefined),
  startHerdrTerminalBridge: jest.fn().mockResolvedValue(undefined),
}));

import nativeClient from '../packages/react-native-whip-ssh/src';

const mockGenerated = jest.requireMock(
  '../packages/react-native-whip-ssh/src/generated-entry',
);
const mockEventSink = mockGenerated.setHerdrTerminalEventSink.mock.calls[0][0];
const mockApiEventSink = mockGenerated.setHerdrEventSink.mock.calls[0][0];

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

    mockEventSink.control({
      clientKey: 'client-1',
      terminalId: 'terminal-1',
      kind: 'notify',
      text: 'done',
      body: 'body',
      notificationKind: 2,
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
    mockGenerated.herdrControlRequest.mockResolvedValueOnce({ kind: 'ok' });

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
});
