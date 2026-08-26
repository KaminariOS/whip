import {
  foregroundUsesBriefAlerts,
  agentNotificationTitle,
  isAgentAlertingStatus,
  previousVisibleAgentStatus,
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
  test('treats public idle as already seen and done as completion', () => {
    expect(isAgentAlertingStatus('blocked')).toBe(true);
    expect(isAgentAlertingStatus('done')).toBe(true);
    expect(isAgentAlertingStatus('working')).toBe(false);
    expect(isAgentAlertingStatus('idle')).toBe(false);
    expect(shouldNotifyAgentTransition('working', 'idle')).toBe(false);
    expect(shouldNotifyAgentTransition('working', 'done')).toBe(true);
    expect(shouldNotifyAgentTransition('idle', 'idle')).toBe(false);
    expect(shouldNotifyAgentTransition('unknown', 'idle')).toBe(false);
  });

  test('uses the visible status instead of a raced runtime-cache value', () => {
    const visibleSnapshot = {
      agents: [{ ...agent, agent_status: 'working' as const }],
      panes: [],
    };
    expect(previousVisibleAgentStatus(visibleSnapshot, agent.pane_id, 'done')).toBe('working');
    expect(shouldNotifyAgentTransition(
      previousVisibleAgentStatus(visibleSnapshot, agent.pane_id, 'done'),
      'done',
    )).toBe(true);
  });

  test('uses the visible pane when agent metadata is temporarily absent', () => {
    const visibleSnapshot = {
      agents: [],
      panes: [{
        terminal_id: agent.terminal_id,
        agent_status: 'working' as const,
        workspace_id: agent.workspace_id,
        tab_id: agent.tab_id,
        pane_id: agent.pane_id,
        focused: agent.focused,
        revision: agent.revision,
      }],
    };
    expect(previousVisibleAgentStatus(visibleSnapshot, agent.pane_id, 'done')).toBe('working');
  });

  test('uses brief notifications whenever the app is in the foreground', () => {
    expect(shouldNotifyAgentTransition('working', 'blocked')).toBe(true);
    expect(shouldNotifyAgentTransition('working', 'done')).toBe(true);
    expect(foregroundUsesBriefAlerts(true)).toBe(true);
    expect(foregroundUsesBriefAlerts(false)).toBe(false);
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
