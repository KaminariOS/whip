import type { AgentInfo, PaneInfo, PaneLayoutSnapshot, TabInfo, WorkspaceInfo } from '../types';

export interface HerdrApiRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrApiMessage {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
  subscription_id?: string;
  event?: unknown;
  data?: unknown;
}

export interface HerdrApiEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id?: string;
  focused_tab_id?: string;
  focused_pane_id?: string;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: PaneLayoutSnapshot[];
  agents: AgentInfo[];
}

export interface SessionSnapshotResult {
  type: 'session_snapshot';
  snapshot: SessionSnapshot;
}

const LIFECYCLE_SUBSCRIPTIONS = [
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.closed',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated',
] as const;

export function sessionSnapshotRequest(id = 'android_snapshot'): HerdrApiRequest {
  return { id, method: 'session.snapshot', params: {} };
}

export function eventsSubscribeRequest(
  paneIds: string[],
  id = 'android_events',
): HerdrApiRequest {
  return {
    id,
    method: 'events.subscribe',
    params: {
      subscriptions: [
        ...LIFECYCLE_SUBSCRIPTIONS.map(type => ({ type })),
        ...[...new Set(paneIds)].sort().map(pane_id => ({
          type: 'pane.agent_status_changed',
          pane_id,
        })),
      ],
    },
  };
}

export function apiRequestLine(request: HerdrApiRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function apiErrorMessage(message: HerdrApiMessage): string | null {
  if (!message.error) return null;
  return message.error.message || message.error.code || JSON.stringify(message.error);
}

/** Accepts Herdr's direct event envelope and the legacy wrapped event shape. */
export function apiEvent(message: HerdrApiMessage): HerdrApiEvent | null {
  if (typeof message.event === 'string') {
    return {
      event: message.event,
      data: isRecord(message.data) ? message.data : {},
    };
  }
  if (isRecord(message.event) && typeof message.event.event === 'string') {
    return {
      event: message.event.event,
      data: isRecord(message.event.data) ? message.event.data : {},
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Decodes newline-delimited socket JSON while ignoring PTY shell banners/echo. */
export class HerdrApiBridgeDecoder {
  private buffer = '';

  push(chunk: string): HerdrApiMessage[] {
    this.buffer += chunk.replace(/\r/g, '');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    const messages: HerdrApiMessage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim()) as HerdrApiMessage;
        if (parsed && typeof parsed === 'object') messages.push(parsed);
      } catch {
        // Interactive shells may emit a prompt or MOTD before `exec` takes over.
      }
    }
    return messages;
  }
}
