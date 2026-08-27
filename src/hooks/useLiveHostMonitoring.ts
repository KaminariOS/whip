import { useEffect, useEffectEvent } from 'react';
import { AppState } from 'react-native';

import { HerdrClient } from '../services/HerdrClient';
import { flushLatencyDiagnosticWrites } from '../services/latencyDiagnostics';
import { recordNetworkDiagnostic } from '../services/networkDiagnostics';
import {
  startBackgroundMonitoring,
  stopBackgroundMonitoring,
} from '../services/backgroundMonitoring';

const LIVE_HOST_HEALTHCHECK_MS = 15_000;
const LIVE_HOST_RECONCILE_MS = 120_000;
const NETWORK_CHANGE_DEBOUNCE_MS = 750;
const VISIBLE_HOST_LATENCY_POLL_MS = 3_000;

export type ReconnectRecoveryTrigger = 'app-resume' | 'network-change';

interface LiveHostMonitoringOptions {
  liveHostCount: number;
  alertsEnabled: boolean;
  restoreComplete: boolean;
  hostsVisible: boolean;
  appAccessLocked: boolean;
  restartConnections: (trigger: ReconnectRecoveryTrigger) => void;
  measureLatencies: (reconnectImmediately?: boolean) => void;
  resumeConnections: (reconcile?: boolean) => void;
  onBackgroundMonitoringError: (error: unknown) => void;
}

/** Owns host heartbeat, foreground recovery, and network-change scheduling. */
export function useLiveHostMonitoring({
  liveHostCount,
  alertsEnabled,
  restoreComplete,
  hostsVisible,
  appAccessLocked,
  restartConnections,
  measureLatencies,
  resumeConnections,
  onBackgroundMonitoringError,
}: LiveHostMonitoringOptions): void {
  const restart = useEffectEvent(restartConnections);
  const measure = useEffectEvent(measureLatencies);
  const resume = useEffectEvent(resumeConnections);
  const reportBackgroundError = useEffectEvent(onBackgroundMonitoringError);

  useEffect(() => {
    if (!restoreComplete) return;
    const operation =
      alertsEnabled && liveHostCount > 0
        ? startBackgroundMonitoring(liveHostCount)
        : stopBackgroundMonitoring();
    operation.catch(reportBackgroundError);
  }, [alertsEnabled, liveHostCount, restoreComplete]);

  useEffect(() => {
    if (liveHostCount === 0) return;
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      recordNetworkDiagnostic('info', 'app-state-changed', {
        from: previousState,
        to: state,
        liveHostCount,
      });
      previousState = state;
      if (state === 'active') {
        restart('app-resume');
        measure(true);
        resume(true);
      } else {
        flushLatencyDiagnosticWrites().catch(() => undefined);
      }
    });
    const heartbeat = setInterval(() => {
      if (AppState.currentState === 'active') {
        measure();
        resume(false);
      }
    }, LIVE_HOST_HEALTHCHECK_MS);
    const reconciliation = setInterval(() => {
      if (AppState.currentState === 'active') resume(true);
    }, LIVE_HOST_RECONCILE_MS);
    return () => {
      subscription.remove();
      clearInterval(heartbeat);
      clearInterval(reconciliation);
    };
  }, [liveHostCount]);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const subscription = HerdrClient.addNetworkChangeListener(() => {
      recordNetworkDiagnostic('warn', 'native-network-change', {
        liveHostCount,
      });
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        restart('network-change');
      }, NETWORK_CHANGE_DEBOUNCE_MS);
    });
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      subscription.remove();
    };
  }, [liveHostCount]);

  useEffect(() => {
    if (!hostsVisible || appAccessLocked) return;
    measure();
    const interval = setInterval(measure, VISIBLE_HOST_LATENCY_POLL_MS);
    return () => clearInterval(interval);
  }, [appAccessLocked, hostsVisible]);
}
