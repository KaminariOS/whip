import {
  agentsForHerdFilter,
  queuesForHerdFilter,
  resolveHerdHostFilter,
  type HerdHostQueue,
} from '../src/herdQueue';
import type { AgentInfo, TabInfo } from '../src/types';

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
  return {
    id,
    label,
    address: `${id}.example`,
    running: true,
    refreshing: false,
    agents: [agent],
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
  }))).toEqual([
    { hostId: 'host-1', hostLabel: 'Studio', tabLabel: 'Build' },
    { hostId: 'host-2', hostLabel: 'Laptop', tabLabel: 'Review' },
  ]);
});

test('selects one host queue and falls back to all when that host closes', () => {
  expect(queuesForHerdFilter(queues, 'host-2')).toEqual([queues[1]]);
  expect(resolveHerdHostFilter(queues, 'closed-host')).toBeNull();
  expect(queuesForHerdFilter(queues, 'closed-host')).toEqual(queues);
});
