import {
  closeHerdrEventSubscription,
  closeAllHerdrTerminalBridges,
  closeHerdrTerminalBridge,
  herdrControlRequest,
  herdrTerminalInput,
  herdrTerminalResize,
  herdrTerminalScroll,
  HerdrControlRequest,
  HerdrControlResult_Tags,
  HerdrAgentSessionKind,
  HerdrAgentStatus,
  HerdrSplitDirection,
  HerdrTerminalAttachLaunchMode,
  HerdrTerminalNotificationKind,
  HerdrTerminalControlEvent_Tags,
  HostRuntimeEvent_Tags,
  HostSshCredential,
  createHostRuntime as createHostRuntimeRust,
  HerdrEvent_Tags,
  pairHost as pairHostRust,
  prepareHerdrTerminalBridge,
  setHerdrEventSink,
  setHerdrTerminalEventSink,
  setHostRuntimeEventSink,
  startHerdrEventSubscription,
  startHerdrTerminalBridge,
  type HerdrBridgeError,
  type HerdrControlError,
  type HerdrControlResult,
  type HerdrEvent,
  type HerdrEventSink,
  type HerdrAgentInfo,
  type HerdrAgentSessionInfo,
  type HerdrPaneInfo,
  type HerdrPaneLayoutRect,
  type HerdrPaneLayoutSnapshot,
  type HerdrPaneScrollInfo,
  type HerdrSessionSnapshot,
  type HerdrTabInfo,
  type HerdrTerminalControlEvent,
  type HerdrTerminalEventSink,
  type HerdrWorkspaceInfo,
  type HerdrWorkspaceWorktreeInfo,
  type HerdrWorktreeInfo,
  type HostRuntimeEvent,
  type HostRuntimeLike,
} from './generated-entry';

type PairingResponse = {
  ok: boolean;
  value?: unknown;
  error?: string;
};

type BridgeEvent = Record<string, unknown> & { type: string; terminalId: string };
type BridgeHandler = (event: BridgeEvent) => void;
type ApiRequest = { method: string; params: Record<string, unknown> };
type ApiResult = Record<string, unknown> & { type: string };
type ApiEvent = { event: string; data: Record<string, unknown> };
type EventStreamEvent = { type: 'event'; event: ApiEvent } | { type: 'closed'; reason?: string };
type EventHandler = (event: EventStreamEvent) => void;
type WhipTerminalInboundTrace = {
  jsReceived: () => number | null;
  decodeComplete: (cookie: number | null) => void;
};

const bridgeHandlers = new Map<string, Map<string, BridgeHandler>>();
const eventHandlers = new Map<string, EventHandler>();
const runtimeHandlers = new Map<string, (event: RuntimeLifecycleEvent) => void>();

export type RuntimeSshConfig = {
  host: string;
  port: number;
  username: string;
  authMode: 'password' | 'key';
  secret: string;
  passphrase?: string;
  forwardAgent?: boolean;
};

export type RuntimeConfig = {
  runtimeId: string;
  ssh: RuntimeSshConfig;
  jumpHosts: RuntimeSshConfig[];
  sessionName: string;
  socketPath?: string;
  cachedSocketPath?: string;
};

export type RuntimeLifecycleEvent =
  | { type: 'connection-state'; state: string; generation: number; reconnectAttempt: number; error?: string }
  | { type: 'reconnect-scheduled'; attempt: number; delayMs: number; reason: string }
  | { type: 'reconnected'; generation: number; restoredTerminals: number }
  | { type: 'terminal-state'; terminalId: string; state: string; error?: string }
  | { type: 'event-stream-closed'; reason: string }
  | { type: 'event-stream-restored'; generation: number }
  | { type: 'fatal-error'; message: string };

function runtimeSshConfig(value: RuntimeSshConfig) {
  return {
    host: value.host,
    port: value.port,
    username: value.username,
    credential: value.authMode === 'password'
      ? HostSshCredential.Password.new({ password: value.secret })
      : HostSshCredential.Key.new({ privateKey: value.secret, passphrase: value.passphrase }),
    forwardAgent: Boolean(value.forwardAgent),
  };
}

function terminalInboundTrace(): WhipTerminalInboundTrace | undefined {
  return (globalThis as typeof globalThis & {
    __whipTerminalInboundTrace?: WhipTerminalInboundTrace;
  }).__whipTerminalInboundTrace;
}

function bridgeHandler(clientKey: string, terminalId: string): BridgeHandler | undefined {
  return bridgeHandlers.get(clientKey)?.get(terminalId);
}

function setBridgeHandler(clientKey: string, terminalId: string, handler: BridgeHandler): void {
  let handlers = bridgeHandlers.get(clientKey);
  if (!handlers) {
    handlers = new Map();
    bridgeHandlers.set(clientKey, handlers);
  }
  handlers.set(terminalId, handler);
}

function removeBridgeHandler(clientKey: string, terminalId: string): void {
  const handlers = bridgeHandlers.get(clientKey);
  handlers?.delete(terminalId);
  if (handlers?.size === 0) bridgeHandlers.delete(clientKey);
}

function bridgeError(error: unknown): Error {
  const nativeError = error as Partial<HerdrBridgeError> & {
    tag?: string;
    inner?: readonly unknown[];
  };
  const message = typeof nativeError.inner?.[0] === 'string'
    ? nativeError.inner[0]
    : error instanceof Error
      ? error.message
      : String(error);
  const result = new Error(message);
  result.name = 'HerdrBridgeError';
  if (nativeError.tag) Object.assign(result, { code: nativeError.tag });
  return result;
}

function controlError(error: unknown): Error {
  const nativeError = error as Partial<HerdrControlError> & {
    tag?: string;
    inner?: readonly unknown[];
  };
  const protocolError = nativeError.tag === 'ProtocolError';
  const message = protocolError && typeof nativeError.inner?.[1] === 'string'
    ? nativeError.inner[1]
    : typeof nativeError.inner?.[0] === 'string'
      ? nativeError.inner[0]
      : error instanceof Error
        ? error.message
        : String(error);
  const result = new Error(message);
  result.name = 'HerdrControlError';
  const code = protocolError && typeof nativeError.inner?.[0] === 'string'
    ? nativeError.inner[0]
    : nativeError.tag;
  if (code) Object.assign(result, { code });
  return result;
}

function eventError(error: unknown): Error {
  const nativeError = error as { tag?: string; inner?: readonly unknown[] };
  const message = typeof nativeError.inner?.[0] === 'string'
    ? nativeError.inner[0]
    : error instanceof Error
      ? error.message
      : String(error);
  const result = new Error(message);
  result.name = 'HerdrEventError';
  if (nativeError.tag) Object.assign(result, { code: nativeError.tag });
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function splitDirection(value: unknown): HerdrSplitDirection {
  if (value === 'right') return HerdrSplitDirection.Right;
  if (value === 'down') return HerdrSplitDirection.Down;
  throw new Error('pane split direction must be right or down');
}

function splitDirectionString(value: HerdrSplitDirection): 'right' | 'down' {
  return value === HerdrSplitDirection.Down ? 'down' : 'right';
}

function agentStatus(value: HerdrAgentStatus): 'idle' | 'working' | 'blocked' | 'done' | 'unknown' {
  switch (value) {
    case HerdrAgentStatus.Idle: return 'idle';
    case HerdrAgentStatus.Working: return 'working';
    case HerdrAgentStatus.Blocked: return 'blocked';
    case HerdrAgentStatus.Done: return 'done';
    case HerdrAgentStatus.Unknown: return 'unknown';
  }
}

function agentSessionKind(value: HerdrAgentSessionKind): 'id' | 'path' {
  return value === HerdrAgentSessionKind.Path ? 'path' : 'id';
}

function nativeTerminalAttachLaunchMode(value: number): HerdrTerminalAttachLaunchMode {
  if (value === 1) return HerdrTerminalAttachLaunchMode.LegacyTerminalAttach;
  if (value === 2) return HerdrTerminalAttachLaunchMode.TerminalAttach;
  throw new Error(`unsupported Herdr terminal attach launch mode ${value}`);
}

function terminalNotificationKind(value: HerdrTerminalNotificationKind): 0 | 1 | 2 {
  switch (value) {
    case HerdrTerminalNotificationKind.Sound: return 0;
    case HerdrTerminalNotificationKind.Toast: return 1;
    case HerdrTerminalNotificationKind.SystemToast: return 2;
  }
}

function controlRequest(request: ApiRequest): HerdrControlRequest {
  const params = request.params || {};
  const text = (key: string): string => String(params[key] ?? '');
  switch (request.method) {
    case 'ping': return HerdrControlRequest.Ping.new();
    case 'session.snapshot': return HerdrControlRequest.SessionSnapshot.new();
    case 'workspace.create': return HerdrControlRequest.WorkspaceCreate.new({
      label: optionalString(params.label),
      cwd: optionalString(params.cwd),
    });
    case 'workspace.focus': return HerdrControlRequest.WorkspaceFocus.new({ workspaceId: text('workspace_id') });
    case 'workspace.rename': return HerdrControlRequest.WorkspaceRename.new({ workspaceId: text('workspace_id'), label: text('label') });
    case 'workspace.close': return HerdrControlRequest.WorkspaceClose.new({ workspaceId: text('workspace_id') });
    case 'tab.create': return HerdrControlRequest.TabCreate.new({ workspaceId: text('workspace_id'), label: optionalString(params.label) });
    case 'tab.focus': return HerdrControlRequest.TabFocus.new({ tabId: text('tab_id') });
    case 'tab.rename': return HerdrControlRequest.TabRename.new({ tabId: text('tab_id'), label: text('label') });
    case 'tab.close': return HerdrControlRequest.TabClose.new({ tabId: text('tab_id') });
    case 'pane.read': return HerdrControlRequest.PaneRead.new({ paneId: text('pane_id'), lines: Number(params.lines) });
    case 'pane.focus': return HerdrControlRequest.PaneFocus.new({ paneId: text('pane_id') });
    case 'pane.rename': return HerdrControlRequest.PaneRename.new({ paneId: text('pane_id'), label: optionalString(params.label) });
    case 'pane.split': return HerdrControlRequest.PaneSplit.new({ paneId: text('target_pane_id'), direction: splitDirection(params.direction) });
    case 'pane.zoom': return HerdrControlRequest.PaneZoom.new({ paneId: text('pane_id') });
    case 'pane.close': return HerdrControlRequest.PaneClose.new({ paneId: text('pane_id') });
    case 'pane.send_input': return HerdrControlRequest.PaneSendInput.new({ paneId: text('pane_id'), text: text('text'), keys: stringArray(params.keys) });
    case 'pane.send_text': return HerdrControlRequest.PaneSendText.new({ paneId: text('pane_id'), text: text('text') });
    case 'pane.send_keys': return HerdrControlRequest.PaneSendKeys.new({ paneId: text('pane_id'), keys: stringArray(params.keys) });
    case 'agent.start': return HerdrControlRequest.AgentStart.new({
      name: text('name'),
      kind: text('kind'),
      paneId: text('pane_id'),
      args: stringArray(params.args),
    });
    case 'agent.focus': return HerdrControlRequest.AgentFocus.new({ target: text('target') });
    case 'agent.prompt': return HerdrControlRequest.AgentPrompt.new({ target: text('target'), text: text('text') });
    default: throw new Error(`Unsupported Herdr API method ${request.method}`);
  }
}

function stringRecord(value: Map<string, string> | undefined): Record<string, string> | undefined {
  return value ? Object.fromEntries(value) : undefined;
}

function assignOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function agentSession(value: HerdrAgentSessionInfo | undefined): Record<string, unknown> | undefined {
  return value && { source: value.source, agent: value.agent, kind: agentSessionKind(value.kind), value: value.value };
}

function paneScroll(value: HerdrPaneScrollInfo | undefined): Record<string, unknown> | undefined {
  return value && {
    offset_from_bottom: value.offsetFromBottom,
    max_offset_from_bottom: value.maxOffsetFromBottom,
    viewport_rows: value.viewportRows,
  };
}

function workspaceWorktree(value: HerdrWorkspaceWorktreeInfo | undefined): Record<string, unknown> | undefined {
  return value && {
    repo_key: value.repoKey,
    repo_name: value.repoName,
    repo_root: value.repoRoot,
    checkout_path: value.checkoutPath,
    is_linked_worktree: value.isLinkedWorktree,
  };
}

function workspace(value: HerdrWorkspaceInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    workspace_id: value.workspaceId,
    number: value.number,
    label: value.label,
    focused: value.focused,
    pane_count: value.paneCount,
    tab_count: value.tabCount,
    active_tab_id: value.activeTabId,
    agent_status: agentStatus(value.agentStatus),
  };
  assignOptional(result, 'tokens', stringRecord(value.tokens));
  assignOptional(result, 'worktree', workspaceWorktree(value.worktree));
  return result;
}

function worktree(value: HerdrWorktreeInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    is_bare: value.isBare,
    is_detached: value.isDetached,
    is_linked_worktree: value.isLinkedWorktree,
    is_prunable: value.isPrunable,
    label: value.label,
    path: value.path,
  };
  assignOptional(result, 'branch', value.branch);
  assignOptional(result, 'open_workspace_id', value.openWorkspaceId);
  return result;
}

function tab(value: HerdrTabInfo): Record<string, unknown> {
  return {
    tab_id: value.tabId,
    workspace_id: value.workspaceId,
    number: value.number,
    label: value.label,
    focused: value.focused,
    pane_count: value.paneCount,
    agent_status: agentStatus(value.agentStatus),
  };
}

function pane(value: HerdrPaneInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    pane_id: value.paneId,
    terminal_id: value.terminalId,
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    focused: value.focused,
    agent_status: agentStatus(value.agentStatus),
    revision: value.revision,
  };
  for (const [key, field] of [
    ['cwd', value.cwd],
    ['foreground_cwd', value.foregroundCwd],
    ['label', value.label],
    ['agent', value.agent],
    ['title', value.title],
    ['terminal_title', value.terminalTitle],
    ['terminal_title_stripped', value.terminalTitleStripped],
    ['display_agent', value.displayAgent],
  ] as const) assignOptional(result, key, field);
  assignOptional(result, 'state_labels', stringRecord(value.stateLabels));
  assignOptional(result, 'tokens', stringRecord(value.tokens));
  assignOptional(result, 'agent_session', agentSession(value.agentSession));
  assignOptional(result, 'scroll', paneScroll(value.scroll));
  return result;
}

function agent(value: HerdrAgentInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    pane_id: value.paneId,
    terminal_id: value.terminalId,
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    focused: value.focused,
    agent_status: agentStatus(value.agentStatus),
    revision: value.revision,
  };
  for (const [key, field] of [
    ['cwd', value.cwd], ['foreground_cwd', value.foregroundCwd], ['agent', value.agent],
    ['name', value.name], ['title', value.title], ['terminal_title', value.terminalTitle],
    ['terminal_title_stripped', value.terminalTitleStripped], ['display_agent', value.displayAgent],
    ['interactive_ready', value.interactiveReady], ['launch_pending', value.launchPending],
    ['screen_detection_skipped', value.screenDetectionSkipped], ['state_change_seq', value.stateChangeSeq],
  ] as const) assignOptional(result, key, field);
  assignOptional(result, 'state_labels', stringRecord(value.stateLabels));
  assignOptional(result, 'tokens', stringRecord(value.tokens));
  assignOptional(result, 'agent_session', agentSession(value.agentSession));
  return result;
}

function rect(value: HerdrPaneLayoutRect): Record<string, unknown> {
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function layout(value: HerdrPaneLayoutSnapshot): Record<string, unknown> {
  return {
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    zoomed: value.zoomed,
    area: rect(value.area),
    focused_pane_id: value.focusedPaneId,
    panes: value.panes.map(item => ({ pane_id: item.paneId, focused: item.focused, rect: rect(item.rect) })),
    splits: value.splits.map(item => ({ id: item.id, direction: splitDirectionString(item.direction), ratio: item.ratio, rect: rect(item.rect) })),
  };
}

function snapshot(value: HerdrSessionSnapshot): Record<string, unknown> {
  return {
    version: value.version,
    protocol: value.protocol,
    focused_workspace_id: value.focusedWorkspaceId,
    focused_tab_id: value.focusedTabId,
    focused_pane_id: value.focusedPaneId,
    agents: value.agents.map(agent),
    workspaces: value.workspaces.map(workspace),
    tabs: value.tabs.map(tab),
    panes: value.panes.map(pane),
    layouts: value.layouts.map(layout),
  };
}

function apiResult(value: HerdrControlResult): ApiResult {
  switch (value.tag) {
    case HerdrControlResult_Tags.Pong:
      return { type: 'pong', version: value.inner.version, protocol: value.inner.protocol };
    case HerdrControlResult_Tags.SessionSnapshot:
      return { type: 'session_snapshot', snapshot: snapshot(value.inner.snapshot) };
    case HerdrControlResult_Tags.WorkspaceCreated:
      return {
        type: 'workspace_created',
        workspace: workspace(value.inner.workspace),
        tab: tab(value.inner.tab),
        root_pane: pane(value.inner.rootPane),
      };
    case HerdrControlResult_Tags.WorkspaceInfo:
      return { type: 'workspace_info', workspace: workspace(value.inner.workspace) };
    case HerdrControlResult_Tags.TabCreated:
      return { type: 'tab_created', tab: tab(value.inner.tab), root_pane: pane(value.inner.rootPane) };
    case HerdrControlResult_Tags.TabInfo:
      return { type: 'tab_info', tab: tab(value.inner.tab) };
    case HerdrControlResult_Tags.PaneInfo:
      return { type: 'pane_info', pane: pane(value.inner.pane) };
    case HerdrControlResult_Tags.PaneRead:
      return { type: 'pane_read', read: { text: value.inner.read.text } };
    case HerdrControlResult_Tags.AgentStarted:
      return { type: 'agent_started', agent: agent(value.inner.agent), argv: value.inner.argv };
    case HerdrControlResult_Tags.AgentInfo:
      return { type: 'agent_info', agent: agent(value.inner.agent) };
    case HerdrControlResult_Tags.AgentPrompted:
      return { type: 'agent_prompted', agent: agent(value.inner.agent) };
    case HerdrControlResult_Tags.PaneZoom:
      return { type: 'pane_zoom' };
    case HerdrControlResult_Tags.Ok:
      return { type: 'ok' };
  }
}

function apiEvent(value: HerdrEvent): ApiEvent {
  const { tag: eventTag, inner } = value;
  switch (eventTag) {
    case HerdrEvent_Tags.WorkspaceCreated:
      return { event: 'workspace.created', data: { workspace: workspace(inner.workspace) } };
    case HerdrEvent_Tags.WorkspaceUpdated:
      return { event: 'workspace.updated', data: { workspace: workspace(inner.workspace) } };
    case HerdrEvent_Tags.WorkspaceMetadataUpdated:
      return { event: 'workspace.metadata_updated', data: { workspace: workspace(inner.workspace) } };
    case HerdrEvent_Tags.WorkspaceClosed: {
      const data: Record<string, unknown> = { workspace_id: inner.workspaceId };
      assignOptional(data, 'workspace', inner.workspace && workspace(inner.workspace));
      return { event: 'workspace.closed', data };
    }
    case HerdrEvent_Tags.WorkspaceRenamed:
      return { event: 'workspace.renamed', data: { workspace_id: inner.workspaceId, label: inner.label } };
    case HerdrEvent_Tags.WorkspaceMoved:
      return { event: 'workspace.moved', data: {
        workspace_id: inner.workspaceId,
        insert_index: inner.insertIndex,
        workspaces: inner.workspaces.map(workspace),
      } };
    case HerdrEvent_Tags.WorkspaceReordered: {
      const data: Record<string, unknown> = {
        workspace_ids: inner.workspaceIds,
        workspaces: inner.workspaces.map(workspace),
      };
      assignOptional(data, 'before_workspace_id', inner.beforeWorkspaceId);
      return { event: 'workspace.reordered', data };
    }
    case HerdrEvent_Tags.WorkspaceFocused:
      return { event: 'workspace.focused', data: { workspace_id: inner.workspaceId } };
    case HerdrEvent_Tags.WorktreeCreated:
      return { event: 'worktree.created', data: {
        workspace: workspace(inner.workspace),
        worktree: worktree(inner.worktree),
      } };
    case HerdrEvent_Tags.WorktreeOpened:
      return { event: 'worktree.opened', data: {
        workspace: workspace(inner.workspace),
        worktree: worktree(inner.worktree),
        already_open: inner.alreadyOpen,
      } };
    case HerdrEvent_Tags.WorktreeRemoved: {
      const data: Record<string, unknown> = {
        workspace_id: inner.workspaceId,
        worktree: worktree(inner.worktree),
        forced: inner.forced,
      };
      assignOptional(data, 'workspace', inner.workspace && workspace(inner.workspace));
      return { event: 'worktree.removed', data };
    }
    case HerdrEvent_Tags.TabCreated:
      return { event: 'tab.created', data: { tab: tab(inner.tab) } };
    case HerdrEvent_Tags.TabClosed:
      return { event: 'tab.closed', data: { workspace_id: inner.workspaceId, tab_id: inner.tabId } };
    case HerdrEvent_Tags.TabFocused:
      return { event: 'tab.focused', data: { workspace_id: inner.workspaceId, tab_id: inner.tabId } };
    case HerdrEvent_Tags.TabRenamed:
      return { event: 'tab.renamed', data: {
        workspace_id: inner.workspaceId,
        tab_id: inner.tabId,
        label: inner.label,
      } };
    case HerdrEvent_Tags.TabMoved:
      return { event: 'tab.moved', data: {
        workspace_id: inner.workspaceId,
        tab_id: inner.tabId,
        insert_index: inner.insertIndex,
        tabs: inner.tabs.map(tab),
      } };
    case HerdrEvent_Tags.PaneCreated:
      return { event: 'pane.created', data: { pane: pane(inner.pane) } };
    case HerdrEvent_Tags.PaneUpdated:
      return { event: 'pane.updated', data: { pane: pane(inner.pane) } };
    case HerdrEvent_Tags.PaneClosed:
      return { event: 'pane.closed', data: { workspace_id: inner.workspaceId, pane_id: inner.paneId } };
    case HerdrEvent_Tags.PaneFocused:
      return { event: 'pane.focused', data: { workspace_id: inner.workspaceId, pane_id: inner.paneId } };
    case HerdrEvent_Tags.PaneExited:
      return { event: 'pane.exited', data: { workspace_id: inner.workspaceId, pane_id: inner.paneId } };
    case HerdrEvent_Tags.PaneMoved: {
      const data: Record<string, unknown> = {
        previous_pane_id: inner.previousPaneId,
        previous_workspace_id: inner.previousWorkspaceId,
        previous_tab_id: inner.previousTabId,
        pane: pane(inner.pane),
      };
      assignOptional(data, 'created_workspace', inner.createdWorkspace && workspace(inner.createdWorkspace));
      assignOptional(data, 'created_tab', inner.createdTab && tab(inner.createdTab));
      assignOptional(data, 'closed_workspace_id', inner.closedWorkspaceId);
      assignOptional(data, 'closed_tab_id', inner.closedTabId);
      return { event: 'pane.moved', data };
    }
    case HerdrEvent_Tags.PaneOutputChanged:
      return { event: 'pane.output_changed', data: {
        workspace_id: inner.workspaceId,
        pane_id: inner.paneId,
        revision: inner.revision,
      } };
    case HerdrEvent_Tags.PaneAgentDetected: {
      const data: Record<string, unknown> = {
        workspace_id: inner.workspaceId,
        pane_id: inner.paneId,
        released: inner.released,
      };
      assignOptional(data, 'agent', inner.agent);
      assignOptional(data, 'final_status', inner.finalStatus === undefined ? undefined : agentStatus(inner.finalStatus));
      return { event: 'pane.agent_detected', data };
    }
    case HerdrEvent_Tags.PaneAgentStatusChanged: {
      const data: Record<string, unknown> = {
        workspace_id: inner.workspaceId,
        pane_id: inner.paneId,
        agent_status: agentStatus(inner.agentStatus),
      };
      assignOptional(data, 'agent', inner.agent);
      assignOptional(data, 'title', inner.title);
      assignOptional(data, 'display_agent', inner.displayAgent);
      assignOptional(data, 'state_labels', stringRecord(inner.stateLabels));
      return { event: 'pane.agent_status_changed', data };
    }
    case HerdrEvent_Tags.LayoutUpdated:
      return { event: 'layout.updated', data: { layout: layout(inner.layout) } };
    case HerdrEvent_Tags.ProtocolUnknown:
      return { event: 'protocol.unknown', data: { raw_event: inner.rawEvent } };
    case HerdrEvent_Tags.ProtocolInvalid:
      return { event: 'protocol.invalid', data: { raw_event: inner.rawEvent, reason: inner.reason } };
  }
}

function controlEvent(terminalId: string, event: HerdrTerminalControlEvent): BridgeEvent {
  switch (event.tag) {
    case HerdrTerminalControlEvent_Tags.Closed:
      return { type: 'closed', terminalId, text: event.inner.reason };
    case HerdrTerminalControlEvent_Tags.Notify:
      return {
        type: 'notify',
        terminalId,
        text: event.inner.text,
        body: event.inner.body,
        kind: terminalNotificationKind(event.inner.kind),
      };
    case HerdrTerminalControlEvent_Tags.Clipboard:
      return { type: 'clipboard', terminalId, text: event.inner.text };
    case HerdrTerminalControlEvent_Tags.Title:
      return { type: 'title', terminalId, text: event.inner.title };
    case HerdrTerminalControlEvent_Tags.ReloadSoundConfig:
      return { type: 'reload_sound_config', terminalId };
    case HerdrTerminalControlEvent_Tags.MouseCapture:
      return { type: 'mouse_capture', terminalId, flag: event.inner.enabled };
    case HerdrTerminalControlEvent_Tags.KittyKeyboardReportAll:
      return { type: 'kitty_keyboard_report_all', terminalId, flag: event.inner.enabled };
    case HerdrTerminalControlEvent_Tags.PrefixInputSource:
      return { type: 'prefix_input_source', terminalId, flag: event.inner.enabled };
    case HerdrTerminalControlEvent_Tags.TerminalBell:
      return { type: 'terminal_bell', terminalId, count: event.inner.count };
    case HerdrTerminalControlEvent_Tags.Ignored:
      return { type: 'ignored', terminalId };
  }
}

const herdrTerminalEventSink: HerdrTerminalEventSink = {
  terminalFrame(clientKey, terminalId, sequence, width, height, full, bytes): void {
    const handler = bridgeHandler(clientKey, terminalId);
    if (!handler) return;
    const inboundTraceCookie = terminalInboundTrace()?.jsReceived() ?? null;
    terminalInboundTrace()?.decodeComplete(inboundTraceCookie);
    handler({
      type: 'terminal',
      terminalId,
      seq: Number(sequence),
      width,
      height,
      full,
      bytes,
      final: true,
      inboundTraceCookie,
    });
  },
  graphicsFrame(clientKey, terminalId, bytes): void {
    bridgeHandler(clientKey, terminalId)?.({
      type: 'graphics',
      terminalId,
      bytes,
    });
  },
  control(clientKey, terminalId, event): void {
    const handler = bridgeHandler(clientKey, terminalId);
    handler?.(controlEvent(terminalId, event));
    if (event.tag === HerdrTerminalControlEvent_Tags.Closed) removeBridgeHandler(clientKey, terminalId);
  },
};

const herdrEventSink: HerdrEventSink = {
  event(clientKey, event): void {
    eventHandlers.get(clientKey)?.({ type: 'event', event: apiEvent(event) });
  },
  closed(clientKey, reason): void {
    const handler = eventHandlers.get(clientKey);
    eventHandlers.delete(clientKey);
    handler?.({ type: 'closed', reason });
  },
};

const hostRuntimeEventSink = {
  event(event: HostRuntimeEvent): void {
    const { tag, inner } = event;
    if (tag === HostRuntimeEvent_Tags.Herdr) {
      eventHandlers.get(inner.runtimeId)?.({ type: 'event', event: apiEvent(inner.event) });
      return;
    }
    const handler = runtimeHandlers.get(inner.runtimeId);
    if (!handler) return;
    switch (tag) {
      case HostRuntimeEvent_Tags.ConnectionStateChanged:
        handler({
          type: 'connection-state',
          state: String(inner.status.state).toLowerCase(),
          generation: Number(inner.status.generation),
          reconnectAttempt: inner.status.reconnectAttempt,
          error: inner.status.error,
        });
        break;
      case HostRuntimeEvent_Tags.ReconnectScheduled:
        handler({ type: 'reconnect-scheduled', attempt: inner.attempt, delayMs: Number(inner.delayMs), reason: inner.reason });
        break;
      case HostRuntimeEvent_Tags.Reconnected:
        handler({ type: 'reconnected', generation: Number(inner.generation), restoredTerminals: inner.restoredTerminals });
        break;
      case HostRuntimeEvent_Tags.TerminalStateChanged:
        handler({ type: 'terminal-state', terminalId: inner.terminalId, state: String(inner.state).toLowerCase(), error: inner.error });
        break;
      case HostRuntimeEvent_Tags.EventSubscriptionClosed:
        eventHandlers.get(inner.runtimeId)?.({ type: 'closed', reason: inner.reason });
        handler({ type: 'event-stream-closed', reason: inner.reason });
        break;
      case HostRuntimeEvent_Tags.EventSubscriptionRestored:
        handler({ type: 'event-stream-restored', generation: Number(inner.generation) });
        break;
      case HostRuntimeEvent_Tags.FatalError:
        handler({ type: 'fatal-error', message: inner.message });
        break;
    }
  },
};

setHerdrTerminalEventSink(herdrTerminalEventSink);
setHerdrEventSink(herdrEventSink);
setHostRuntimeEventSink(hostRuntimeEventSink);

export class NativeHostRuntime {
  readonly runtimeId: string;
  readonly transportKey: string;

  constructor(
    private readonly runtime: HostRuntimeLike,
    lifecycleHandler?: (event: RuntimeLifecycleEvent) => void,
  ) {
    this.runtimeId = runtime.runtimeId();
    this.transportKey = runtime.transportKey();
    if (lifecycleHandler) runtimeHandlers.set(this.runtimeId, lifecycleHandler);
  }

  connect(): Promise<void> { return this.runtime.connect(); }

  async disconnect(): Promise<void> {
    runtimeHandlers.delete(this.runtimeId);
    eventHandlers.delete(this.runtimeId);
    bridgeHandlers.delete(this.transportKey);
    await this.runtime.disconnect();
  }

  recover(immediate: boolean, reason: string): Promise<void> {
    return this.runtime.recover(immediate, reason);
  }

  status() { return this.runtime.status(); }

  resolvedSocketPath(): string | undefined { return this.runtime.resolvedSocketPath(); }

  resolveHerdrSocketPath(): Promise<string> { return this.runtime.resolveControlSocket(); }

  async requestHerdrApi(request: ApiRequest): Promise<ApiResult> {
    try {
      return apiResult(await this.runtime.controlRequest(controlRequest(request)));
    } catch (error) {
      throw controlError(error);
    }
  }

  async startHerdrEventStream(paneIds: string[], handler: EventHandler): Promise<void> {
    eventHandlers.set(this.runtimeId, handler);
    try {
      await this.runtime.subscribeEvents(paneIds);
    } catch (error) {
      eventHandlers.delete(this.runtimeId);
      throw eventError(error);
    }
  }

  closeHerdrEventStream(): void {
    eventHandlers.delete(this.runtimeId);
    this.runtime.unsubscribeEvents();
  }

  async startHerdrBridge(
    terminalId: string,
    takeover: boolean,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    launchMode: number,
    handler: BridgeHandler,
  ): Promise<void> {
    setBridgeHandler(this.transportKey, terminalId, handler);
    try {
      await this.runtime.openTerminal(terminalId, takeover, columns, rows, cellWidthPx, cellHeightPx);
    } catch (error) {
      removeBridgeHandler(this.transportKey, terminalId);
      throw bridgeError(error);
    }
  }

  herdrBridgeInput(terminalId: string, text: string): Promise<void> {
    try { this.runtime.terminalInput(terminalId, text); return Promise.resolve(); }
    catch (error) { return Promise.reject(bridgeError(error)); }
  }

  herdrBridgeResize(terminalId: string, columns: number, rows: number, cellWidthPx: number, cellHeightPx: number): Promise<void> {
    try { this.runtime.resizeTerminal(terminalId, columns, rows, cellWidthPx, cellHeightPx); return Promise.resolve(); }
    catch (error) { return Promise.reject(bridgeError(error)); }
  }

  herdrBridgeScroll(terminalId: string, up: boolean, lines: number, column?: number, row?: number, modifiers = 0): Promise<void> {
    try { this.runtime.scrollTerminal(terminalId, up, lines, column, row, modifiers); return Promise.resolve(); }
    catch (error) { return Promise.reject(bridgeError(error)); }
  }

  closeHerdrBridge(terminalId: string): void {
    removeBridgeHandler(this.transportKey, terminalId);
    this.runtime.closeTerminal(terminalId);
  }

  closeAllHerdrBridges(): void {
    bridgeHandlers.delete(this.transportKey);
    this.runtime.closeAllTerminals();
  }

  hasHerdrBridge(terminalId: string): boolean { return this.runtime.hasTerminal(terminalId); }

  isHerdrBridgeOpening(terminalId: string): boolean { return this.runtime.isTerminalOpening(terminalId); }
}

const nativeClient = {
  createHostRuntime(config: RuntimeConfig, handler?: (event: RuntimeLifecycleEvent) => void): NativeHostRuntime {
    const runtime = createHostRuntimeRust({
      runtimeId: config.runtimeId,
      ssh: runtimeSshConfig(config.ssh),
      jumpHosts: config.jumpHosts.map(runtimeSshConfig),
      sessionName: config.sessionName,
      socketPath: config.socketPath,
      cachedSocketPath: config.cachedSocketPath,
    });
    return new NativeHostRuntime(runtime, handler);
  },
  async pairHost(code: string, publicKey: string, deviceName: string): Promise<unknown> {
    const response = JSON.parse(await pairHostRust(code, publicKey, deviceName)) as PairingResponse;
    if (!response.ok) throw new Error(response.error || 'WP4 pairing failed');
    return response.value;
  },

  async prepareHerdrBridge(
    clientKey: string,
    socketPath: string,
    protocol: number,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ): Promise<void> {
    try {
      await prepareHerdrTerminalBridge(
        clientKey,
        socketPath,
        protocol,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      );
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async requestHerdrApi(
    clientKey: string,
    socketPath: string,
    request: ApiRequest,
  ): Promise<ApiResult> {
    try {
      return apiResult(await herdrControlRequest(clientKey, socketPath, controlRequest(request)));
    } catch (error) {
      throw controlError(error);
    }
  },

  async startHerdrEventStream(
    clientKey: string,
    socketPath: string,
    protocol: number,
    paneIds: string[],
    handler: EventHandler,
  ): Promise<void> {
    eventHandlers.set(clientKey, handler);
    try {
      await startHerdrEventSubscription(clientKey, socketPath, protocol, paneIds);
    } catch (error) {
      eventHandlers.delete(clientKey);
      throw eventError(error);
    }
  },

  closeHerdrEventStream(clientKey: string): void {
    eventHandlers.delete(clientKey);
    closeHerdrEventSubscription(clientKey);
  },

  async startHerdrBridge(
    clientKey: string,
    socketPath: string,
    protocol: number,
    terminalId: string,
    takeover: boolean,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    terminalAttachLaunchMode: number,
    handler: BridgeHandler,
  ): Promise<void> {
    setBridgeHandler(clientKey, terminalId, handler);
    try {
      await startHerdrTerminalBridge(
        clientKey,
        socketPath,
        protocol,
        terminalId,
        takeover,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
        nativeTerminalAttachLaunchMode(terminalAttachLaunchMode),
      );
    } catch (error) {
      removeBridgeHandler(clientKey, terminalId);
      throw bridgeError(error);
    }
  },

  async herdrBridgeInput(clientKey: string, terminalId: string, text: string): Promise<void> {
    try {
      herdrTerminalInput(clientKey, terminalId, text);
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async herdrBridgeResize(
    clientKey: string,
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ): Promise<void> {
    try {
      herdrTerminalResize(
        clientKey,
        terminalId,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      );
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async herdrBridgeScroll(
    clientKey: string,
    terminalId: string,
    up: boolean,
    lines: number,
    column: number | undefined,
    row: number | undefined,
    modifiers: number,
  ): Promise<void> {
    try {
      herdrTerminalScroll(clientKey, terminalId, up, lines, column, row, modifiers);
    } catch (error) {
      throw bridgeError(error);
    }
  },

  closeHerdrBridge(clientKey: string, terminalId: string): void {
    removeBridgeHandler(clientKey, terminalId);
    closeHerdrTerminalBridge(clientKey, terminalId);
  },

  closeAllHerdrBridges(clientKey: string): void {
    bridgeHandlers.delete(clientKey);
    closeAllHerdrTerminalBridges(clientKey);
  },
};

export default nativeClient;
