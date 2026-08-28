import {
  activePaneForTerminal,
  agentChatControlState,
  chatAgentForPane,
  openCodeSessionIdForPane,
} from '../src/lib/agentChatSession';
import type { TerminalSession } from '../src/terminalSessions';
import type { PaneInfo } from '../src/types';

const pane = (agent: string, sessionAgent = agent, value = ''): PaneInfo => ({
  pane_id: 'pane',
  terminal_id: 'terminal',
  tab_id: 'tab',
  workspace_id: 'workspace',
  focused: true,
  revision: 1,
  agent,
  display_agent: agent,
  agent_status: 'idle',
  ...(value
    ? {
        agent_session: {
          source: `herdr:${sessionAgent}`,
          agent: sessionAgent,
          kind: 'id' as const,
          value,
        },
      }
    : {}),
});

test('chat control is limited to Codex and OpenCode panes', () => {
  expect(chatAgentForPane(undefined)).toBeNull();
  expect(chatAgentForPane(pane('codex'))).toBe('codex');
  expect(chatAgentForPane(pane('opencode'))).toBe('opencode');
  expect(chatAgentForPane(pane('open-code'))).toBe('opencode');
  expect(chatAgentForPane(pane('claude'))).toBeNull();
});

test('chat control follows the supported active terminal pane', () => {
  const codex = pane('codex');
  const unsupported = { ...pane('claude'), terminal_id: 'other-terminal' };
  const sessions: TerminalSession[] = [
    {
      terminalId: codex.terminal_id,
      paneId: codex.pane_id,
      title: 'Codex',
      kind: 'herdr',
      status: 'connected',
      reconnectAttempt: 0,
    },
    {
      terminalId: unsupported.terminal_id,
      paneId: unsupported.pane_id,
      title: 'Claude',
      kind: 'herdr',
      status: 'connected',
      reconnectAttempt: 0,
    },
  ];

  const activeCodex = activePaneForTerminal(
    [codex, unsupported],
    sessions,
    codex.terminal_id,
  );
  const activeUnsupported = activePaneForTerminal(
    [codex, unsupported],
    sessions,
    unsupported.terminal_id,
  );

  expect(agentChatControlState(activeCodex, false, false)).toEqual({
    agent: 'codex',
    disabled: false,
  });
  expect(agentChatControlState(activeUnsupported, false, false)).toBeNull();
  expect(activePaneForTerminal([codex], sessions, 'missing')).toBeUndefined();
});

test('busy and history-loading states disable a supported chat control', () => {
  const codex = pane('codex');

  expect(agentChatControlState(codex, true, false)?.disabled).toBe(true);
  expect(agentChatControlState(codex, false, true)?.disabled).toBe(true);
  expect(agentChatControlState(codex, false, false)?.disabled).toBe(false);
});

test('OpenCode session identity requires its native id format', () => {
  expect(
    openCodeSessionIdForPane(pane('opencode', 'opencode', 'ses_abc123')),
  ).toBe('ses_abc123');
  expect(
    openCodeSessionIdForPane(pane('opencode', 'opencode', '../history')),
  ).toBeNull();
  expect(
    openCodeSessionIdForPane(pane('opencode', 'codex', 'ses_abc123')),
  ).toBeNull();
});
