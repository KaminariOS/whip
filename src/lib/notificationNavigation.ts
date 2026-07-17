import type { LiveHostSession } from '../liveHostSessions';
import type { PaneInfo } from '../types';

interface NotificationResponseLike {
  actionIdentifier: string;
  notification: {
    request: {
      identifier: string;
      content: {
        data?: Record<string, unknown>;
      };
    };
  };
}

export interface AgentNotificationTarget {
  notificationId: string;
  hostId: string;
  paneId: string;
}

export function parseAgentNotificationTarget(
  response: NotificationResponseLike,
  defaultActionIdentifier: string,
): AgentNotificationTarget | null {
  if (response.actionIdentifier !== defaultActionIdentifier) return null;
  const { identifier, content } = response.notification.request;
  const { hostId, paneId } = content.data || {};
  if (typeof identifier !== 'string' || !identifier) return null;
  if (typeof hostId !== 'string' || !hostId) return null;
  if (typeof paneId !== 'string' || !paneId) return null;
  return { notificationId: identifier, hostId, paneId };
}

export function resolveAgentNotificationTarget(
  state: { sessions: Array<Pick<LiveHostSession, 'id' | 'hostId' | 'snapshot'>> },
  target: Pick<AgentNotificationTarget, 'hostId' | 'paneId'>,
): { sessionId: string; pane: PaneInfo } | null {
  const session = state.sessions.find(item => item.hostId === target.hostId);
  const pane = session?.snapshot.panes.find(item => item.pane_id === target.paneId);
  return session && pane ? { sessionId: session.id, pane } : null;
}
