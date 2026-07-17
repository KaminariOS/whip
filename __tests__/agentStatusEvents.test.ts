import {
  agentFromStatusEvent,
  agentStatusFromEvent,
  shouldNotifyAgentTransition,
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

  test('notifies for background completion reported as idle', () => {
    expect(shouldNotifyAgentTransition('working', 'idle', true)).toBe(true);
    expect(shouldNotifyAgentTransition('working', 'idle', false)).toBe(false);
    expect(shouldNotifyAgentTransition('idle', 'idle', true)).toBe(false);
    expect(shouldNotifyAgentTransition('unknown', 'idle', true)).toBe(false);
  });

  test('always notifies for actionable blocked and done states', () => {
    expect(shouldNotifyAgentTransition('working', 'blocked', false)).toBe(true);
    expect(shouldNotifyAgentTransition('working', 'done', false)).toBe(true);
  });

  test('merges presentation metadata from a status event', () => {
    expect(agentFromStatusEvent(agent, {
      agent_status: 'idle',
      title: 'Silver price found',
      display_agent: 'Codex',
      state_labels: { idle: 'Ready' },
    })).toEqual({
      ...agent,
      agent_status: 'idle',
      title: 'Silver price found',
      display_agent: 'Codex',
      state_labels: { idle: 'Ready' },
    });
    expect(agentFromStatusEvent(agent, { agent_status: 'invalid' })).toBeNull();
  });
});
