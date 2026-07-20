import type { AppTab } from './types';

export interface MobileNavigationState {
  tab: AppTab;
  lastNonTerminalTab: Exclude<AppTab, 'terminal'>;
}

export const initialMobileNavigation: MobileNavigationState = {
  tab: 'hosts',
  lastNonTerminalTab: 'hosts',
};

export function selectMobileTab(state: MobileNavigationState, tab: AppTab): MobileNavigationState {
  return {
    tab,
    lastNonTerminalTab: tab === 'terminal' ? state.lastNonTerminalTab : tab,
  };
}

export function handleMobileBack(state: MobileNavigationState): {
  handled: boolean;
  state: MobileNavigationState;
} {
  if (state.tab === 'terminal') {
    return { handled: true, state: selectMobileTab(state, state.lastNonTerminalTab) };
  }
  if (state.tab !== 'hosts') return { handled: true, state: selectMobileTab(state, 'hosts') };
  return { handled: false, state };
}
