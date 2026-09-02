import type {
  NativeAgentChatBinding,
  NativeAgentTranscriptState,
} from 'react-native-whip-ssh';

import { emptyTranscript, type AgentChatState } from '../src/agentChat';
import {
  reconcileAgentChatViews,
  type AgentChatViewState,
} from '../src/lib/agentChatReconciliation';
import { AgentChatPresentationPhase } from '../src/lib/agentChatPresentation';

const TERMINAL_ID = 'terminal-1';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function nativeState(revision: number): NativeAgentTranscriptState {
  return {
    agent: 'codex',
    messages: [],
    revision,
    sessionId: SESSION_ID,
    status: 'live',
    turns: [],
  };
}

function binding(state: NativeAgentTranscriptState): NativeAgentChatBinding {
  return {
    agent: 'codex',
    bindingGeneration: 1,
    bindingToken: 'binding-1',
    paneId: 'pane-1',
    runtimeIncarnation: 1,
    sessionId: SESSION_ID,
    state,
    terminalId: TERMINAL_ID,
    transcriptKey: 'transcript-1',
  };
}

function chatState(revision: number): AgentChatState {
  return {
    revision,
    sessionId: SESSION_ID,
    status: 'live',
    transcript: emptyTranscript(SESSION_ID),
  };
}

test('snapshot reconciliation preserves a concurrently revealed viewport', () => {
  const originalState = chatState(3);
  const visible: AgentChatViewState = {
    binding: binding(nativeState(3)),
    presentation: {
      generation: 7,
      phase: AgentChatPresentationPhase.Visible,
    },
    state: originalState,
  };
  const current = new Map([[TERMINAL_ID, visible]]);
  const updatedState = chatState(30);
  const projection = {
    type: 'bound' as const,
    binding: binding(nativeState(30)),
    state: updatedState,
  };

  const reconciled = reconcileAgentChatViews(
    current,
    new Set([TERMINAL_ID]),
    new Map([[TERMINAL_ID, projection]]),
    new Map(),
  );

  expect(reconciled).not.toBe(current);
  expect(reconciled.get(TERMINAL_ID)?.state).toBe(updatedState);
  expect(reconciled.get(TERMINAL_ID)?.presentation).toBe(
    visible.presentation,
  );
  expect(reconciled.get(TERMINAL_ID)?.presentation.phase).toBe(
    AgentChatPresentationPhase.Visible,
  );
});

test('unchanged reconciliation preserves the map identity', () => {
  const state = chatState(3);
  const view: AgentChatViewState = {
    binding: binding(nativeState(3)),
    presentation: {
      generation: 7,
      phase: AgentChatPresentationPhase.Visible,
    },
    state,
  };
  const current = new Map([[TERMINAL_ID, view]]);

  const reconciled = reconcileAgentChatViews(
    current,
    new Set([TERMINAL_ID]),
    new Map([
      [
        TERMINAL_ID,
        { type: 'bound' as const, binding: view.binding, state },
      ],
    ]),
    new Map(),
  );

  expect(reconciled).toBe(current);
});
