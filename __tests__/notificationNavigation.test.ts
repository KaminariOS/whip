import {
  parseAgentNotificationTarget,
  resolveAgentNotificationTarget,
} from '../src/lib/notificationNavigation';
import type { HerdrSnapshot, PaneInfo } from '../src/types';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

function response(data: Record<string, unknown>, actionIdentifier = DEFAULT_ACTION) {
  return {
    actionIdentifier,
    notification: {
      request: {
        identifier: 'notification-42',
        content: { data },
      },
    },
  };
}

function pane(paneId: string, terminalId: string): PaneInfo {
  return {
    pane_id: paneId,
    terminal_id: terminalId,
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    focused: false,
    agent_status: 'done',
    revision: 1,
  };
}

function snapshot(panes: PaneInfo[]): HerdrSnapshot {
  return {
    server: { running: true },
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
    agents: [],
    workspaces: [],
    tabs: [],
    panes,
    layouts: [],
  };
}

describe('agent notification navigation', () => {
  test('parses a default notification tap with its host and pane', () => {
    expect(parseAgentNotificationTarget(
      response({ hostId: 'savior', paneId: 'w1:p4' }),
      DEFAULT_ACTION,
    )).toEqual({
      notificationId: 'notification-42',
      hostId: 'savior',
      paneId: 'w1:p4',
    });
  });

  test('ignores non-default actions and incomplete routing data', () => {
    expect(parseAgentNotificationTarget(
      response({ hostId: 'savior', paneId: 'w1:p4' }, 'dismiss'),
      DEFAULT_ACTION,
    )).toBeNull();
    expect(parseAgentNotificationTarget(response({ paneId: 'w1:p4' }), DEFAULT_ACTION)).toBeNull();
  });

  test('resolves the pane on the originating host even when pane ids overlap', () => {
    const saviorPane = pane('w1:p4', 'savior-terminal');
    const builderPane = pane('w1:p4', 'builder-terminal');
    const state = {
      sessions: [
        { id: 'savior-live', hostId: 'savior', snapshot: snapshot([saviorPane]) },
        { id: 'builder-live', hostId: 'builder', snapshot: snapshot([builderPane]) },
      ],
    };

    expect(resolveAgentNotificationTarget(state, { hostId: 'builder', paneId: 'w1:p4' })).toEqual({
      sessionId: 'builder-live',
      pane: builderPane,
    });
    expect(resolveAgentNotificationTarget(state, { hostId: 'missing', paneId: 'w1:p4' })).toBeNull();
  });
});
