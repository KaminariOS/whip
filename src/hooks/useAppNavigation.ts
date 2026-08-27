import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BackHandler } from 'react-native';

import {
  handleMobileBack,
  initialMobileNavigation,
  selectMobileTab,
  type MobileNavigationState,
} from '../mobileNavigation';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  type AppPerformanceTrace,
} from '../services/performanceTrace';
import type { AppTab } from '../types';

interface AppNavigationOptions {
  appReady: boolean;
  preferencesLoaded: boolean;
  preferredTab: AppTab;
  recordLastTab: (tab: AppTab) => void;
  dismissTopOverlay: () => boolean;
  onFirstTabMounted?: () => void;
}

export interface AppNavigationController {
  state: MobileNavigationState;
  mountedTabs: ReadonlySet<AppTab>;
  herdHostFilterId: string | null;
  herdWorkspaceFilterIds: Readonly<Record<string, string | null>>;
  selectedPaneId: string | null;
  licensesOpen: boolean;
  selectTab: (tab: AppTab) => void;
  selectPane: (paneId: string | null) => void;
  selectHerdHost: (sessionId: string | null) => void;
  setHerdWorkspaceFilter: (
    sessionId: string,
    workspaceId: string | null,
  ) => void;
  showTerminal: (sessionId?: string) => void;
  showHerd: (sessionId?: string, workspaceId?: string | null) => void;
  clearSessionView: (sessionId: string) => void;
  openLicenses: () => void;
  closeLicenses: () => void;
}

/** Owns application tab policy, mounted-tab retention, view filters, and Android back. */
export function useAppNavigation({
  appReady,
  preferencesLoaded,
  preferredTab,
  recordLastTab,
  dismissTopOverlay,
  onFirstTabMounted,
}: AppNavigationOptions): AppNavigationController {
  const [state, setState] = useState(initialMobileNavigation);
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<AppTab>>(
    () => new Set(),
  );
  const [herdHostFilterId, setHerdHostFilterId] = useState<string | null>(null);
  const [herdWorkspaceFilterIds, setHerdWorkspaceFilterIds] = useState<
    Record<string, string | null>
  >({});
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const hydratedRef = useRef(false);
  const startupTraceRef = useRef<AppPerformanceTrace | null>(null);
  const tabMountTracesRef = useRef(new Map<AppTab, AppPerformanceTrace>());
  const dismissOverlay = useEffectEvent(dismissTopOverlay);
  const notifyFirstTabMounted = useEffectEvent(() => onFirstTabMounted?.());

  useEffect(() => {
    const tabMountTraces = tabMountTracesRef.current;
    startupTraceRef.current = beginAppPerformanceTrace(
      'Whip startup to first tab',
    );
    return () => {
      endAppPerformanceTrace(startupTraceRef.current);
      for (const trace of tabMountTraces.values()) {
        endAppPerformanceTrace(trace);
      }
      tabMountTraces.clear();
    };
  }, []);

  useEffect(() => {
    if (!preferencesLoaded || hydratedRef.current) return;
    hydratedRef.current = true;
    setState(current =>
      selectMobileTab(
        current,
        preferredTab === 'terminal' ? 'hosts' : preferredTab,
      ),
    );
  }, [preferencesLoaded, preferredTab]);

  useEffect(() => {
    if (!appReady || mountedTabs.has(state.tab)) return;
    const tab = state.tab;
    const trace = beginAppPerformanceTrace(`Whip first tab mount: ${tab}`);
    if (trace) tabMountTracesRef.current.set(tab, trace);
    setMountedTabs(current => {
      if (current.has(tab)) return current;
      const next = new Set(current);
      next.add(tab);
      return next;
    });
  }, [appReady, mountedTabs, state.tab]);

  useEffect(() => {
    for (const [tab, trace] of tabMountTracesRef.current) {
      if (!mountedTabs.has(tab)) continue;
      endAppPerformanceTrace(trace);
      tabMountTracesRef.current.delete(tab);
    }
    if (mountedTabs.size > 0 && startupTraceRef.current) {
      endAppPerformanceTrace(startupTraceRef.current);
      startupTraceRef.current = null;
      notifyFirstTabMounted();
    }
  }, [mountedTabs]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    recordLastTab(state.tab);
  }, [recordLastTab, state.tab]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (licensesOpen) {
          setLicensesOpen(false);
          return true;
        }
        if (dismissOverlay()) return true;
        if (selectedPaneId) {
          setSelectedPaneId(null);
          return true;
        }
        const result = handleMobileBack(state);
        if (result.handled) setState(result.state);
        return result.handled;
      },
    );
    return () => subscription.remove();
  }, [licensesOpen, selectedPaneId, state]);

  const selectTab = useCallback((tab: AppTab) => {
    setState(current => selectMobileTab(current, tab));
  }, []);

  const setHerdWorkspaceFilter = useCallback(
    (sessionId: string, workspaceId: string | null) => {
      setHerdWorkspaceFilterIds(current =>
        current[sessionId] === workspaceId
          ? current
          : { ...current, [sessionId]: workspaceId },
      );
    },
    [],
  );

  const showTerminal = useCallback((_sessionId?: string) => {
    setSelectedPaneId(null);
    setState(current => selectMobileTab(current, 'terminal'));
  }, []);

  const showHerd = useCallback(
    (sessionId?: string, workspaceId?: string | null) => {
      if (sessionId) {
        setHerdHostFilterId(sessionId);
        if (workspaceId) setHerdWorkspaceFilter(sessionId, workspaceId);
      }
      setState(current => selectMobileTab(current, 'herd'));
    },
    [setHerdWorkspaceFilter],
  );

  const clearSessionView = useCallback((sessionId: string) => {
    setSelectedPaneId(null);
    setHerdHostFilterId(current => (current === sessionId ? null : current));
    setHerdWorkspaceFilterIds(current => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);
  const openLicenses = useCallback(() => setLicensesOpen(true), []);
  const closeLicenses = useCallback(() => setLicensesOpen(false), []);

  return useMemo(
    () => ({
      state,
      mountedTabs,
      herdHostFilterId,
      herdWorkspaceFilterIds,
      selectedPaneId,
      licensesOpen,
      selectTab,
      selectPane: setSelectedPaneId,
      selectHerdHost: setHerdHostFilterId,
      setHerdWorkspaceFilter,
      showTerminal,
      showHerd,
      clearSessionView,
      openLicenses,
      closeLicenses,
    }),
    [
      clearSessionView,
      closeLicenses,
      herdHostFilterId,
      herdWorkspaceFilterIds,
      licensesOpen,
      mountedTabs,
      openLicenses,
      selectTab,
      selectedPaneId,
      setHerdWorkspaceFilter,
      showHerd,
      showTerminal,
      state,
    ],
  );
}
