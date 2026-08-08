import { hostRuntimeSummary } from '../src/lib/hostRuntimeSummary';
import type { AgentInfo, AgentStatus, HerdrSnapshot } from '../src/types';

function agent(agent_status: AgentStatus, pane_id: string): AgentInfo {
  return {
    agent_status,
    focused: false,
    pane_id,
    revision: 1,
    tab_id: 'tab-1',
    terminal_id: `terminal-${pane_id}`,
    workspace_id: 'workspace-1',
  };
}

function snapshot(agents: AgentInfo[], protocol?: number): HerdrSnapshot {
  return {
    agents,
    focused_pane_id: null,
    focused_tab_id: null,
    focused_workspace_id: null,
    layouts: [],
    panes: [],
    server: { running: protocol !== undefined, protocol },
    tabs: [],
    workspaces: [],
  };
}

describe('host runtime summaries', () => {
  it('counts each live agent state and exposes the Herdr protocol', () => {
    expect(hostRuntimeSummary(snapshot([
      agent('working', 'pane-1'),
      agent('working', 'pane-2'),
      agent('blocked', 'pane-3'),
      agent('done', 'pane-4'),
    ], 19))).toEqual({
      agentStatus: 'blocked',
      agentTotal: 4,
      protocol: 19,
    });
  });

  it('reports no protocol and zero agents for an unavailable Herdr server', () => {
    expect(hostRuntimeSummary(snapshot([]))).toEqual({
      agentStatus: 'unknown',
      agentTotal: 0,
      protocol: null,
    });
  });
});
