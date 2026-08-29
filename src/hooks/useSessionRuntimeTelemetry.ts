import { startTransition, useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { RuntimeDiagnostic } from 'react-native-whip-ssh';

import type { useLiveHostTelemetry } from './useLiveHostTelemetry';
import type { LiveRuntime, SessionRuntimeStore } from './sessionRuntimeTypes';
import { findLiveHostSession } from '../liveHostSessions';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import {
  SLOW_HOST_LATENCY_MS,
  isSlowHostLatency,
  recordHostLatencyFailure,
  recordSlowHostLatency,
  type HostLatencyMeasurement,
} from '../services/latencyDiagnostics';
import {
  networkErrorMessage,
  recordNetworkDiagnostic,
} from '../services/networkDiagnostics';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  withAppPerformanceTrace,
  type AppPerformanceTrace,
} from '../services/performanceTrace';

const HOST_LATENCY_PROBE_TRACE = 'Whip host latency probe end to end';

function recordLatencyMeasurement(
  sessionId: string,
  measurement: HostLatencyMeasurement,
): void {
  if (!isSlowHostLatency(measurement)) return;
  recordNetworkDiagnostic('warn', 'latency-probe-slow', {
    sessionId,
    latencyMs: measurement.latencyMs,
    sshRttMs: measurement.sshRttMs,
    totalMs: measurement.totalMs,
    runtimeOverheadMs: measurement.runtimeOverheadMs,
  });
  reportBackgroundFailure(
    recordSlowHostLatency(sessionId, measurement),
    'slow-host-latency-persist',
  );
}

export function useSessionRuntimeTelemetry({
  state,
  stateRef,
  runtimesRef,
  telemetry,
}: Pick<SessionRuntimeStore, 'state' | 'stateRef' | 'runtimesRef'> & {
  telemetry: ReturnType<typeof useLiveHostTelemetry>;
}) {
  const latencyPingsInFlightRef = useRef(new Map<string, LiveRuntime>());
  const latencyStateApplyTracesRef = useRef(new Set<AppPerformanceTrace>());
  const { clearLatency, recordLatency } = telemetry;

  useEffect(() => {
    for (const trace of latencyStateApplyTracesRef.current) {
      endAppPerformanceTrace(trace);
    }
    latencyStateApplyTracesRef.current.clear();
  }, [telemetry.state]);

  useEffect(
    () => () => {
      for (const trace of latencyStateApplyTracesRef.current) {
        endAppPerformanceTrace(trace);
      }
      latencyStateApplyTracesRef.current.clear();
    },
    [],
  );

  const handleRuntimeDiagnostic = useCallback(
    (
      sessionId: string,
      runtime: LiveRuntime,
      diagnostic: RuntimeDiagnostic,
    ) => {
      recordNetworkDiagnostic(
        diagnostic.outcome === 'failed'
          ? 'error'
          : diagnostic.durationMs >= SLOW_HOST_LATENCY_MS
          ? 'warn'
          : 'info',
        'native-runtime-diagnostic',
        {
          sessionId,
          operation: diagnostic.operation,
          outcome: diagnostic.outcome,
          durationMs: Math.round(diagnostic.durationMs * 10) / 10,
          transportDurationMs:
            diagnostic.transportDurationMs === undefined
              ? undefined
              : Math.round(diagnostic.transportDurationMs * 10) / 10,
          terminalId: diagnostic.terminalId,
          error: diagnostic.error,
        },
      );
      if (
        diagnostic.operation === 'host-latency-probe' &&
        diagnostic.outcome === 'failed' &&
        !runtime.latencyDiagnosticFailureRecorded
      ) {
        runtime.latencyDiagnosticFailureRecorded = true;
        reportBackgroundFailure(
          recordHostLatencyFailure(
            sessionId,
            diagnostic.durationMs,
            diagnostic.error || 'Host latency probe failed',
          ),
          'host-latency-failure-persist',
        );
      }
    },
    [],
  );

  const handleReconnectRecovered = useCallback(
    (_sessionId: string, runtime: LiveRuntime) => {
      runtime.latencyFailures = 0;
      runtime.latencyFailureActive = false;
      runtime.latencyDiagnosticFailureRecorded = false;
    },
    [],
  );

  const probeLiveHost = useCallback(
    (sessionId: string) => {
      if (AppState.currentState !== 'active') return;
      const session = findLiveHostSession(stateRef.current, sessionId);
      if (session?.status !== 'ready') return;
      const runtime = runtimesRef.current.get(sessionId);
      if (
        !runtime ||
        latencyPingsInFlightRef.current.get(sessionId) === runtime
      ) {
        return;
      }
      latencyPingsInFlightRef.current.set(sessionId, runtime);
      withAppPerformanceTrace(HOST_LATENCY_PROBE_TRACE, () =>
        runtime.client.measureLatency(),
      )
        .then(measurement => {
          if (runtimesRef.current.get(sessionId) !== runtime) return;
          runtime.latencyFailures = 0;
          runtime.latencyDiagnosticFailureRecorded = false;
          if (runtime.latencyFailureActive) {
            runtime.latencyFailureActive = false;
            recordNetworkDiagnostic('info', 'latency-probe-recovered', {
              sessionId,
              latencyMs: measurement.latencyMs,
            });
          }
          const trace = beginAppPerformanceTrace(
            'Whip host latency state apply',
          );
          startTransition(() => {
            const changed = recordLatency(sessionId, measurement.latencyMs);
            if (trace && changed) latencyStateApplyTracesRef.current.add(trace);
            else endAppPerformanceTrace(trace);
          });
          recordLatencyMeasurement(sessionId, measurement);
        })
        .catch(probeError => {
          if (runtimesRef.current.get(sessionId) !== runtime) return;
          runtime.latencyFailures += 1;
          clearLatency(sessionId);
          if (!runtime.latencyFailureActive) {
            runtime.latencyFailureActive = true;
            recordNetworkDiagnostic('warn', 'latency-probe-failed', {
              sessionId,
              failures: runtime.latencyFailures,
              error: networkErrorMessage(probeError),
            });
          }
        })
        .finally(() => {
          if (latencyPingsInFlightRef.current.get(sessionId) === runtime) {
            latencyPingsInFlightRef.current.delete(sessionId);
          }
        });
    },
    [clearLatency, recordLatency, runtimesRef, stateRef],
  );

  const measureLatencies = useCallback(() => {
    for (const session of state.sessions) {
      if (session.status === 'ready') probeLiveHost(session.id);
    }
  }, [probeLiveHost, state.sessions]);

  return {
    clearLatency,
    handleReconnectRecovered,
    handleRuntimeDiagnostic,
    measureLatencies,
  };
}
