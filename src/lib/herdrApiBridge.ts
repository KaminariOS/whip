import type {
  ErrorResponse,
  Request,
  RequestForProtocol,
  ResponseResult,
  SessionSnapshot,
  Subscription,
  SupportedHerdrProtocol,
  SuccessResponse,
} from '../generated/herdrApi';
import { decodeHerdrEvent, type HerdrEvent } from './herdrEvents';

export type HerdrApiRequest = Request;

export type HerdrApiMessage = Partial<SuccessResponse> & Partial<ErrorResponse> & {
  subscription_id?: string;
  event?: unknown;
  data?: unknown;
};

export type HerdrApiEvent = HerdrEvent;

export type SessionSnapshotResult = Extract<ResponseResult, { type: 'session_snapshot' }>;
export type { SessionSnapshot };

const LIFECYCLE_SUBSCRIPTIONS = [
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
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
] as const satisfies ReadonlyArray<Subscription['type']>;

export function sessionSnapshotRequest(
  id = 'android_snapshot',
): Extract<HerdrApiRequest, { method: 'session.snapshot' }> {
  return { id, method: 'session.snapshot', params: {} };
}

export function eventsSubscribeRequest(
  protocol: SupportedHerdrProtocol,
  paneIds: string[],
  id = 'android_events',
): Extract<RequestForProtocol<typeof protocol>, { method: 'events.subscribe' }> {
  const lifecycleSubscriptions = protocol === 17
    ? LIFECYCLE_SUBSCRIPTIONS.filter(type => type !== 'workspace.reordered')
    : LIFECYCLE_SUBSCRIPTIONS;
  return {
    id,
    method: 'events.subscribe',
    params: {
      subscriptions: [
        ...lifecycleSubscriptions.map(type => ({ type })),
        ...[...new Set(paneIds)].sort().map(pane_id => ({
          type: 'pane.agent_status_changed' as const,
          pane_id,
        })),
      ],
    },
  } as Extract<RequestForProtocol<typeof protocol>, { method: 'events.subscribe' }>;
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
    return decodeHerdrEvent(message.event, message.data);
  }
  if (isRecord(message.event) && typeof message.event.event === 'string') {
    return decodeHerdrEvent(message.event.event, message.event.data);
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
