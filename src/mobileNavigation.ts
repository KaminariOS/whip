import type { AppScreen, AppTab } from './types';

export interface MobileNavigationState {
  tab: AppTab;
  lastNonTerminalTab: Exclude<AppTab, 'terminal'>;
  stack: AppScreen[];
}

export const initialMobileNavigation: MobileNavigationState = {
  tab: 'hosts',
  lastNonTerminalTab: 'hosts',
  stack: [],
};

export function selectMobileTab(state: MobileNavigationState, tab: AppTab): MobileNavigationState {
  return {
    tab,
    lastNonTerminalTab: tab === 'terminal' ? state.lastNonTerminalTab : tab,
    stack: [],
  };
}

export function pushMobileScreen(state: MobileNavigationState, screen: AppScreen): MobileNavigationState {
  return { ...state, stack: [...state.stack, screen] };
}

export function popMobileScreen(state: MobileNavigationState): MobileNavigationState {
  return state.stack.length > 0 ? { ...state, stack: state.stack.slice(0, -1) } : state;
}

export function handleMobileBack(state: MobileNavigationState): {
  handled: boolean;
  state: MobileNavigationState;
} {
  if (state.stack.length > 0) return { handled: true, state: popMobileScreen(state) };
  if (state.tab === 'terminal') {
    return { handled: true, state: selectMobileTab(state, state.lastNonTerminalTab) };
  }
  if (state.tab !== 'hosts') return { handled: true, state: selectMobileTab(state, 'hosts') };
  return { handled: false, state };
}
