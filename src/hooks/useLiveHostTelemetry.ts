import { useCallback, useMemo, useRef, useState } from 'react';

import {
  initialLatencyWarningState,
  nextLatencyWarningState,
  type LatencyWarningState,
} from '../lib/latencyWarning';

export interface LiveHostTelemetry {
  latencyMs: number | null;
  latencyWarning: LatencyWarningState;
}

const emptyTelemetry: LiveHostTelemetry = {
  latencyMs: null,
  latencyWarning: initialLatencyWarningState,
};

export type LiveHostTelemetryState = ReadonlyMap<string, LiveHostTelemetry>;

export function recordLiveHostLatency(
  state: LiveHostTelemetryState,
  sessionId: string,
  latencyMs: number,
): LiveHostTelemetryState {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return state;
  const current = state.get(sessionId) ?? emptyTelemetry;
  const latencyWarning = nextLatencyWarningState(
    current.latencyWarning,
    latencyMs,
  );
  if (
    current.latencyMs === latencyMs &&
    current.latencyWarning === latencyWarning
  )
    return state;
  const next = new Map(state);
  next.set(sessionId, { latencyMs, latencyWarning });
  return next;
}

export function clearLiveHostLatency(
  state: LiveHostTelemetryState,
  sessionId: string,
): LiveHostTelemetryState {
  return state.has(sessionId)
    ? new Map([...state].filter(([id]) => id !== sessionId))
    : state;
}

/** Owns volatile RTT/health samples separately from durable host session state. */
export function useLiveHostTelemetry() {
  const [state, setState] = useState<LiveHostTelemetryState>(() => new Map());
  const stateRef = useRef(state);
  stateRef.current = state;

  const recordLatency = useCallback((sessionId: string, latencyMs: number) => {
    const next = recordLiveHostLatency(stateRef.current, sessionId, latencyMs);
    if (next === stateRef.current) return false;
    stateRef.current = next;
    setState(next);
    return true;
  }, []);

  const clearLatency = useCallback((sessionId: string) => {
    const next = clearLiveHostLatency(stateRef.current, sessionId);
    if (next === stateRef.current) return false;
    stateRef.current = next;
    setState(next);
    return true;
  }, []);

  const get = useCallback(
    (sessionId: string): LiveHostTelemetry =>
      state.get(sessionId) ?? emptyTelemetry,
    [state],
  );

  return useMemo(
    () => ({ state, get, recordLatency, clearLatency }),
    [clearLatency, get, recordLatency, state],
  );
}
