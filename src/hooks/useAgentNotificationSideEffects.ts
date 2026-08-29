import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { HostRuntimeState } from 'react-native-whip-ssh';

import type { HostManagementController } from './useHostManagement';
import type { useAgentNotifications } from './useAgentNotifications';
import type { SessionRuntimeStore } from './sessionRuntimeTypes';
import {
  foregroundUsesBriefAlerts,
  isAgentAlertingStatus,
  previousVisibleAgentStatus,
  shouldNotifyAgentTransition,
  tabNameForAgent,
} from '../lib/agentStatusEvents';
import {
  parseAgentNotificationTarget,
  resolveAgentNotificationTarget,
} from '../lib/notificationNavigation';
import { alertAgent, dismissAgentAlertsForPane } from '../services/alerts';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { defaultDevicePreferences } from '../services/devicePreferences';
import { recordNetworkDiagnostic } from '../services/networkDiagnostics';
import type { AgentStatus, HerdrSnapshot, PaneInfo } from '../types';

interface AgentStateChange {
  sessionId: string;
  hostState: HostRuntimeState;
  snapshot: HerdrSnapshot;
  visibleSnapshot?: HerdrSnapshot;
  previousStatuses: Map<string, AgentStatus> | null;
  changedAgentPaneIds?: string[];
}

export function useAgentNotificationSideEffects({
  alertsEnabled,
  persistentAlertDurationSeconds,
  ttsEnabled,
}: {
  alertsEnabled: boolean;
  persistentAlertDurationSeconds: number;
  ttsEnabled: boolean;
}) {
  const alertsEnabledRef = useRef(alertsEnabled);
  const persistentAlertDurationSecondsRef = useRef(
    defaultDevicePreferences.persistentAlertDurationSeconds,
  );
  const ttsEnabledRef = useRef(ttsEnabled);
  alertsEnabledRef.current = alertsEnabled;
  persistentAlertDurationSecondsRef.current = persistentAlertDurationSeconds;
  ttsEnabledRef.current = ttsEnabled;

  return useCallback(
    ({
      sessionId,
      hostState,
      snapshot,
      visibleSnapshot,
      previousStatuses,
      changedAgentPaneIds = [],
    }: AgentStateChange): Map<string, AgentStatus> => {
      const statuses = new Map(
        snapshot.agents.map(agent => [agent.pane_id, agent.agent_status]),
      );
      const changed = new Set(changedAgentPaneIds);
      if (previousStatuses) {
        for (const agent of snapshot.agents) {
          if (previousStatuses.get(agent.pane_id) !== agent.agent_status) {
            changed.add(agent.pane_id);
          }
        }
      }
      for (const paneId of changed) {
        const agent = snapshot.agents.find(item => item.pane_id === paneId);
        const status =
          agent?.agent_status ??
          snapshot.panes.find(item => item.pane_id === paneId)?.agent_status;
        if (!status) continue;
        const previous = previousVisibleAgentStatus(
          visibleSnapshot,
          paneId,
          previousStatuses?.get(paneId),
        );
        if (!isAgentAlertingStatus(status)) {
          reportBackgroundFailure(
            dismissAgentAlertsForPane(sessionId, paneId),
            'pane-alert-dismiss',
          );
        }
        if (
          agent &&
          alertsEnabledRef.current &&
          shouldNotifyAgentTransition(previous, status)
        ) {
          const brief = foregroundUsesBriefAlerts(
            AppState.currentState === 'active',
          );
          reportBackgroundFailure(
            alertAgent(
              agent,
              ttsEnabledRef.current,
              { hostId: sessionId, paneId },
              tabNameForAgent(agent, snapshot.tabs),
              brief ? 'brief' : 'persistent',
              persistentAlertDurationSecondsRef.current * 1_000,
            ),
            'agent-alert-schedule',
          );
        }
        recordNetworkDiagnostic('info', 'agent-status-state-change', {
          sessionId,
          paneId,
          status,
          revision: hostState.revision,
        });
      }
      return statuses;
    },
    [],
  );
}

export function useAgentNotificationNavigation({
  notifications,
  restoreComplete,
  stateRef,
  hosts,
  openPaneTerminal,
}: {
  notifications: ReturnType<typeof useAgentNotifications>;
  restoreComplete: boolean;
  stateRef: SessionRuntimeStore['stateRef'];
  hosts: HostManagementController;
  openPaneTerminal: (
    sessionId: string,
    pane: PaneInfo,
    focusAgent?: boolean,
  ) => void;
}): void {
  const openNotificationTarget = useEffectEvent(() => {
    if (!notifications.response) return false;
    const target = parseAgentNotificationTarget(
      notifications.response,
      Notifications.DEFAULT_ACTION_IDENTIFIER,
    );
    if (!target || notifications.wasHandled(target.notificationId)) {
      return false;
    }
    const resolved = resolveAgentNotificationTarget(stateRef.current, target);
    if (!resolved) return false;
    hosts.closeEditor();
    hosts.setError(null);
    openPaneTerminal(resolved.sessionId, resolved.pane, true);
    notifications.consume(target.notificationId);
    return true;
  });

  useEffect(() => {
    if (!restoreComplete || !notifications.response) return;
    openNotificationTarget();
  }, [notifications.response, restoreComplete]);
}
