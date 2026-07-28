const TOPOLOGY_INVALIDATING_EVENTS = new Set([
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.closed',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
]);

export const EVENT_REFRESH_DEBOUNCE_MS = 500;

export interface EventRefreshScheduler {
  schedule: (event: string) => void;
  cancel: () => void;
}

export function eventInvalidatesTopology(event: string): boolean {
  return TOPOLOGY_INVALIDATING_EVENTS.has(event);
}

/**
 * Coalesces an event burst into at most one leading topology refresh and one
 * trailing reconciliation. Events already projected into local state only
 * need the trailing refresh once the stream becomes quiet.
 */
export function createEventRefreshScheduler(
  refresh: () => void,
  delayMs = EVENT_REFRESH_DEBOUNCE_MS,
): EventRefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let immediateRefreshIssued = false;
  let changedAfterImmediateRefresh = false;

  const finishBurst = () => {
    timer = null;
    if (!immediateRefreshIssued || changedAfterImmediateRefresh) refresh();
    immediateRefreshIssued = false;
    changedAfterImmediateRefresh = false;
  };

  const schedule = (event: string) => {
    if (eventInvalidatesTopology(event) && !immediateRefreshIssued) {
      refresh();
      immediateRefreshIssued = true;
      changedAfterImmediateRefresh = false;
    } else if (immediateRefreshIssued) {
      changedAfterImmediateRefresh = true;
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(finishBurst, delayMs);
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    immediateRefreshIssued = false;
    changedAfterImmediateRefresh = false;
  };

  return { schedule, cancel };
}
