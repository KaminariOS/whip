import {
  codexChatAction,
  codexSessionIdForPane,
} from '../src/lib/codexSession';
import type { PaneInfo } from '../src/types';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

function pane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    pane_id: 'pane-1', terminal_id: 'terminal-1', tab_id: 'tab-1', workspace_id: 'workspace-1',
    focused: true, revision: 1, agent: 'codex', agent_status: 'idle', ...overrides,
  };
}

describe('Codex native session matching', () => {
  test('no agent_session never guesses', () => {
    expect(codexSessionIdForPane(pane())).toBeNull();
    expect(codexChatAction(pane())).toBe('setup');
  });

  test('invalid and malicious identifiers are rejected without entering a command', () => {
    expect(codexSessionIdForPane(pane({ agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: '../bad' } }))).toBeNull();
  });

  test('extracts only valid Codex ID sessions', () => {
    expect(codexSessionIdForPane(pane({
      agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: ` ${firstId} ` },
    }))).toBe(firstId);
    expect(codexSessionIdForPane(pane({
      agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'path', value: firstId },
    }))).toBeNull();
    expect(codexSessionIdForPane(pane({
      agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: secondId },
    }))).toBe(secondId);
  });

  test('non-Codex panes never request setup', () => {
    expect(codexChatAction(pane({ agent: 'claude', display_agent: 'Claude' }))).toBe('unavailable');
  });
});
