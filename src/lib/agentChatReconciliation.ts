import type { NativeAgentChatBinding } from 'react-native-whip-ssh';

import type { AgentChatState } from '../agentChat';
import type { AgentChatProjection } from '../services/CodexTranscriptService';
import {
  chatPresentationRequested,
  dormantChatPresentation,
  type AgentChatPresentation,
} from './agentChatPresentation';

export interface AgentChatViewState {
  binding: NativeAgentChatBinding;
  presentation: AgentChatPresentation;
  state: AgentChatState;
}

export function reconcileAgentChatViews(
  current: Map<string, AgentChatViewState>,
  liveTerminalIds: ReadonlySet<string>,
  projections: ReadonlyMap<string, AgentChatProjection>,
  reboundPresentations: ReadonlyMap<string, AgentChatPresentation>,
): Map<string, AgentChatViewState> {
  let next: Map<string, AgentChatViewState> | null = null;
  const mutable = () => {
    next ??= new Map(current);
    return next;
  };

  for (const [terminalId, view] of current) {
    if (!liveTerminalIds.has(terminalId)) {
      mutable().delete(terminalId);
      continue;
    }
    const projection = projections.get(terminalId);
    if (!projection) continue;
    if (projection.type === 'no-chat') {
      mutable().delete(terminalId);
      continue;
    }
    if (projection.binding.bindingToken !== view.binding.bindingToken) {
      mutable().set(terminalId, {
        binding: projection.binding,
        presentation: chatPresentationRequested(view.presentation)
          ? reboundPresentations.get(terminalId) ?? dormantChatPresentation()
          : dormantChatPresentation(),
        state: projection.state,
      });
      continue;
    }
    if (projection.state !== view.state) {
      mutable().set(terminalId, { ...view, state: projection.state });
    }
  }

  return next ?? current;
}
