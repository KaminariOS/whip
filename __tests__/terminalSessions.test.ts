import {
  closeTerminalSession,
  emptyTerminalSessions,
  openTerminalSession,
  selectTerminalSession,
  updateTerminalSession,
} from '../src/terminalSessions';
import type { PaneInfo } from '../src/types';

function pane(terminalId: string, paneId: string, label: string): PaneInfo {
  return {
    terminal_id: terminalId,
    pane_id: paneId,
    workspace_id: 'w1',
    tab_id: 't1',
    focused: false,
    label,
    agent_status: 'idle',
    revision: 1,
  };
}

describe('terminal session state', () => {
  test('opens multiple terminals without replacing earlier sessions', () => {
    const first = openTerminalSession(emptyTerminalSessions, pane('term-1', 'pane-1', 'api'));
    const second = openTerminalSession(first, pane('term-2', 'pane-2', 'tests'));

    expect(second.sessions.map(session => session.terminalId)).toEqual(['term-1', 'term-2']);
    expect(second.activeTerminalId).toBe('term-2');
  });

  test('opening an existing terminal selects it and refreshes its title', () => {
    const first = openTerminalSession(emptyTerminalSessions, pane('term-1', 'pane-1', 'old'));
    const second = openTerminalSession(first, pane('term-2', 'pane-2', 'tests'));
    const reopened = openTerminalSession(second, pane('term-1', 'pane-1', 'renamed'));

    expect(reopened.sessions).toHaveLength(2);
    expect(reopened.sessions[0].title).toBe('renamed');
    expect(reopened.activeTerminalId).toBe('term-1');
  });

  test('closing the active terminal selects the nearest surviving session', () => {
    const one = openTerminalSession(emptyTerminalSessions, pane('term-1', 'pane-1', 'one'));
    const two = openTerminalSession(one, pane('term-2', 'pane-2', 'two'));
    const three = openTerminalSession(two, pane('term-3', 'pane-3', 'three'));
    const selected = selectTerminalSession(three, 'term-2');
    const closed = closeTerminalSession(selected, 'term-2');

    expect(closed.sessions.map(session => session.terminalId)).toEqual(['term-1', 'term-3']);
    expect(closed.activeTerminalId).toBe('term-3');
  });

  test('tracks independent connection and reconnect state per terminal', () => {
    const first = openTerminalSession(emptyTerminalSessions, pane('term-1', 'pane-1', 'api'));
    const second = openTerminalSession(first, pane('term-2', 'pane-2', 'tests'));
    const failed = updateTerminalSession(second, 'term-1', {
      status: 'error',
      error: 'connection lost',
      reconnectAttempt: 2,
    });

    expect(failed.sessions[0]).toMatchObject({ status: 'error', error: 'connection lost', reconnectAttempt: 2 });
    expect(failed.sessions[1]).toMatchObject({ status: 'connecting', reconnectAttempt: 0 });
  });
});
