import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chatAgentForPane, openCodeSessionIdForPane } from '../src/lib/agentChatSession';
import type { PaneInfo } from '../src/types';

const pane = (agent: string, sessionAgent = agent, value = ''): PaneInfo => ({
  pane_id: 'pane', terminal_id: 'terminal', tab_id: 'tab', workspace_id: 'workspace',
  focused: true, revision: 1, agent, display_agent: agent, agent_status: 'idle',
  ...(value ? { agent_session: { source: `herdr:${sessionAgent}`, agent: sessionAgent, kind: 'id' as const, value } } : {}),
});

test('chat control is limited to Codex and OpenCode panes', () => {
  expect(chatAgentForPane(undefined)).toBeNull();
  expect(chatAgentForPane(pane('codex'))).toBe('codex');
  expect(chatAgentForPane(pane('opencode'))).toBe('opencode');
  expect(chatAgentForPane(pane('open-code'))).toBe('opencode');
  expect(chatAgentForPane(pane('claude'))).toBeNull();
});

test('SessionScreen only renders Chat for a supported active terminal pane', () => {
  const sessionScreen = readFileSync(
    join(__dirname, '..', 'src/components/SessionScreen.tsx'),
    'utf8',
  );

  expect(sessionScreen).toMatch(
    /const activeTerminalSession = terminalState\.sessions\.find\(\s*session => session\.terminalId === terminalState\.activeTerminalId,\s*\);/,
  );
  expect(sessionScreen).toContain(
    'const activePane = snapshot.panes.find(pane => pane.terminal_id === activeTerminalSession?.terminalId);',
  );
  expect(sessionScreen).toContain('const activeChatAgent = chatAgentForPane(activePane);');
  expect(sessionScreen).toContain('chatControl={activeChatAgent ? {');
  expect(sessionScreen).toContain('disabled: busy || codexChatLoading,');
  expect(sessionScreen).not.toContain('codexChatLoading || !activeTerminalSession');
});

test('OpenCode session identity requires its native id format', () => {
  expect(openCodeSessionIdForPane(pane('opencode', 'opencode', 'ses_abc123'))).toBe('ses_abc123');
  expect(openCodeSessionIdForPane(pane('opencode', 'opencode', '../history'))).toBeNull();
  expect(openCodeSessionIdForPane(pane('opencode', 'codex', 'ses_abc123'))).toBeNull();
});
