import {
  activeTabUsesBriefAlerts,
  agentFromStatusEvent,
  agentNotificationTitle,
  agentStatusFromEvent,
  shouldNotifyAgentTransition,
  tabNameForAgent,
} from '../src/lib/agentStatusEvents';
import type { AgentInfo } from '../src/types';

const agent: AgentInfo = {
  terminal_id: 'terminal-1',
  agent: 'codex',
  agent_status: 'working',
  workspace_id: 'workspace-1',
  tab_id: 'tab-1',
  pane_id: 'pane-1',
  focused: true,
  revision: 1,
};

describe('agent status events', () => {
  test('validates API status values', () => {
    expect(agentStatusFromEvent('idle')).toBe('idle');
    expect(agentStatusFromEvent('running')).toBeNull();
    expect(agentStatusFromEvent(null)).toBeNull();
  });

  test('treats public idle as already seen and done as completion', () => {
    expect(shouldNotifyAgentTransition('working', 'idle')).toBe(false);
    expect(shouldNotifyAgentTransition('working', 'done')).toBe(true);
    expect(shouldNotifyAgentTransition('idle', 'idle')).toBe(false);
    expect(shouldNotifyAgentTransition('unknown', 'idle')).toBe(false);
  });

  test('uses brief notifications for the active focused tab', () => {
    expect(shouldNotifyAgentTransition('working', 'blocked')).toBe(true);
    expect(shouldNotifyAgentTransition('working', 'done')).toBe(true);
    const tabs = [{
      tab_id: 'tab-1',
      workspace_id: 'workspace-1',
      number: 1,
      label: 'Gold research',
      focused: true,
      pane_count: 1,
      agent_status: 'working' as const,
    }];
    expect(activeTabUsesBriefAlerts(agent, tabs, true, true)).toBe(true);
    expect(activeTabUsesBriefAlerts(agent, tabs, false, true)).toBe(false);
  });

  test('keeps the persistent alert for a focused tab on a background host', () => {
    const tabs = [{
      tab_id: 'tab-1',
      workspace_id: 'workspace-1',
      number: 1,
      label: 'Gold research',
      focused: true,
      pane_count: 1,
      agent_status: 'working' as const,
    }];
    expect(activeTabUsesBriefAlerts(agent, tabs, true, false)).toBe(false);
  });

  test('merges presentation metadata from a status event', () => {
    expect(agentFromStatusEvent(agent, {
      agent_status: 'idle',
      title: 'Silver price found',
      display_agent: 'Codex',
      state_change_seq: 42,
      state_labels: { idle: 'Ready' },
    })).toEqual({
      ...agent,
      agent_status: 'idle',
      title: 'Silver price found',
      display_agent: 'Codex',
      state_change_seq: 42,
      state_labels: { idle: 'Ready' },
    });
    expect(agentFromStatusEvent(agent, { agent_status: 'invalid' })).toBeNull();
  });

  test('uses the tab name and agent name in notification titles', () => {
    const tabs = [{
      tab_id: 'tab-1',
      workspace_id: 'workspace-1',
      number: 1,
      label: 'Gold research',
      focused: true,
      pane_count: 1,
      agent_status: 'working' as const,
    }];

    expect(tabNameForAgent(agent, tabs)).toBe('Gold research');
    expect(agentNotificationTitle({ ...agent, agent_status: 'done' }, 'Gold research'))
      .toBe('Gold research · codex finished');
    expect(agentNotificationTitle({ ...agent, agent_status: 'blocked' }, 'Gold research'))
      .toBe('Gold research · codex needs you');
  });
});
