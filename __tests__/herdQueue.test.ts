import {
  agentsForHerdFilter,
  queuesForHerdFilter,
  resolveHerdHostFilter,
  type HerdHostQueue,
} from '../src/herdQueue';
import type { AgentInfo, TabInfo, WorkspaceInfo } from '../src/types';

function queue(id: string, label: string, tabLabel: string): HerdHostQueue {
  const agent = {
    terminal_id: 'terminal-1',
    pane_id: 'pane-1',
    tab_id: 'tab-1',
    workspace_id: 'workspace-1',
    agent_status: 'working',
    focused: false,
    revision: 1,
  } satisfies AgentInfo;
  const tab = {
    tab_id: 'tab-1',
    workspace_id: 'workspace-1',
    number: 1,
    label: tabLabel,
    focused: false,
    pane_count: 1,
    agent_status: 'working',
  } satisfies TabInfo;
  const workspace = {
    workspace_id: 'workspace-1',
    number: 1,
    label: `${label} space`,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: 'tab-1',
    agent_status: 'working',
  } satisfies WorkspaceInfo;
  return {
    id,
    label,
    address: `${id}.example`,
    running: true,
    refreshing: false,
    agents: [agent],
    workspaces: [workspace],
    tabs: [tab],
  };
}

const queues = [
  queue('host-1', 'Studio', 'Build'),
  queue('host-2', 'Laptop', 'Review'),
];

test('merges every host queue while retaining host and tab context', () => {
  expect(agentsForHerdFilter(queues, null).map(item => ({
    hostId: item.hostId,
    hostLabel: item.hostLabel,
    tabLabel: item.tabLabel,
    primaryLabel: item.primaryLabel,
  }))).toEqual([
    { hostId: 'host-1', hostLabel: 'Studio', tabLabel: 'Build', primaryLabel: 'Studio space' },
    { hostId: 'host-2', hostLabel: 'Laptop', tabLabel: 'Review', primaryLabel: 'Laptop space' },
  ]);
});

test('uses the space label and only appends the tab for multi-tab spaces', () => {
  const singleTab = queue('host-1', 'Studio', 'Build');
  const multiTab = queue('host-2', 'Laptop', 'Review');
  multiTab.tabs.push({
    ...multiTab.tabs[0],
    tab_id: 'tab-2',
    number: 2,
    label: 'Tests',
  });
  multiTab.workspaces[0].tab_count = 2;

  expect(agentsForHerdFilter([singleTab, multiTab], null).map(item => item.primaryLabel)).toEqual([
    'Studio space',
    'Laptop space · Review',
  ]);
});

test('falls back to the workspace id when its display label is unavailable', () => {
  const missingWorkspace = queue('host-1', 'Studio', 'Build');
  missingWorkspace.workspaces = [];

  expect(agentsForHerdFilter([missingWorkspace], null)[0].primaryLabel).toBe('workspace-1');
});

test('selects one host queue and falls back to all when that host closes', () => {
  expect(queuesForHerdFilter(queues, 'host-2')).toEqual([queues[1]]);
  expect(resolveHerdHostFilter(queues, 'closed-host')).toBeNull();
  expect(queuesForHerdFilter(queues, 'closed-host')).toEqual(queues);
});
