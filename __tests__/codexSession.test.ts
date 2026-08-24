import { codexChatAction, codexRolloutFindCommand, codexSessionIdForPane, parseCodexRolloutResolution } from '../src/lib/codexSession';
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
  test('resolves only the exact Herdr session ID', () => {
    const output = `/home/me/.codex/sessions/2026/08/24/rollout-a-${firstId}.jsonl\n`;
    expect(parseCodexRolloutResolution(output, firstId)).toContain(firstId);
    expect(codexRolloutFindCommand('/home/me/.codex', firstId)).toContain(`rollout-*-${firstId}.jsonl`);
  });

  test('two sessions in the same cwd never cross', () => {
    expect(parseCodexRolloutResolution(`/same/cwd/rollout-a-${firstId}.jsonl\n`, firstId)).toContain(firstId);
    expect(() => parseCodexRolloutResolution(`/same/cwd/rollout-a-${secondId}.jsonl\n`, firstId)).toThrow('invalid rollout path');
  });

  test('no agent_session never guesses', () => {
    expect(codexSessionIdForPane(pane())).toBeNull();
    expect(codexChatAction(pane())).toBe('setup');
  });

  test('invalid and malicious identifiers are rejected without entering a command', () => {
    expect(() => codexRolloutFindCommand('/home/me/.codex', `${firstId}; touch /tmp/pwned`)).toThrow('Invalid Codex session ID');
    expect(codexSessionIdForPane(pane({ agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: '../bad' } }))).toBeNull();
  });

  test('missing rollout is a clean unavailable result', () => {
    expect(parseCodexRolloutResolution('', firstId)).toBeNull();
  });

  test('non-Codex panes never request setup', () => {
    expect(codexChatAction(pane({ agent: 'claude', display_agent: 'Claude' }))).toBe('unavailable');
  });
});
