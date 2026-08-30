import {
  orderByAgentStatusPriority,
  orderByConnectionAndAgentStatusPriority,
  tabAgentStateChangeSequence,
} from '../src/herdQueue';
import type { AgentInfo, TabInfo } from '../src/types';

test('orders attention statuses before running and idle statuses', () => {
  const statuses = ['idle', 'working', 'done', 'unknown', 'blocked'] as const;
  expect(orderByAgentStatusPriority(statuses, status => status)).toEqual([
    'blocked', 'done', 'working', 'idle', 'unknown',
  ]);
  expect(statuses).toEqual(['idle', 'working', 'done', 'unknown', 'blocked']);
});

test('orders connected hosts first using agent-status priority', () => {
  const hosts = [
    { id: 'offline-done', connected: false, status: 'done' },
    { id: 'connected-working', connected: true, status: 'working' },
    { id: 'connected-blocked', connected: true, status: 'blocked' },
  ] as const;
  expect(orderByConnectionAndAgentStatusPriority(
    hosts,
    host => host.connected,
    host => host.status,
  ).map(host => host.id)).toEqual([
    'connected-blocked', 'connected-working', 'offline-done',
  ]);
});

test('orders equal statuses by the most recent native state change', () => {
  const agents = [
    { id: 'old', status: 'idle', sequence: 105 },
    { id: 'new', status: 'idle', sequence: 379 },
    { id: 'missing', status: 'idle', sequence: undefined },
  ] as const;
  expect(orderByAgentStatusPriority(
    agents,
    item => item.status,
    item => item.sequence,
  ).map(item => item.id)).toEqual(['new', 'old', 'missing']);
});

test('uses the newest matching agent state change for an aggregate tab', () => {
  const tab = {
    tab_id: 'tab-1', workspace_id: 'workspace-1', number: 1, label: 'Build',
    focused: false, pane_count: 2, agent_status: 'working',
  } satisfies TabInfo;
  const base = {
    terminal_id: 'terminal-1', pane_id: 'pane-1', tab_id: 'tab-1',
    workspace_id: 'workspace-1', agent_status: 'working', focused: false,
    revision: 1,
  } satisfies AgentInfo;
  expect(tabAgentStateChangeSequence(tab, [
    { ...base, state_change_seq: 105 },
    { ...base, pane_id: 'pane-2', state_change_seq: 379 },
    { ...base, pane_id: 'pane-3', agent_status: 'blocked', state_change_seq: 500 },
  ])).toBe(379);
});
