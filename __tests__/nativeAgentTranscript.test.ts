import type { NativeAgentTranscriptState } from 'react-native-whip-ssh';

import { agentChatStateFromNative } from '../src/lib/nativeAgentTranscript';

test('keeps normalized native tool fields typed through the presentation boundary', () => {
  const tool = {
    type: 'tool' as const,
    id: 'tool:1',
    callId: 'call:1',
    tool: 'patch',
    state: {
      status: 'completed' as const,
      input: { path: 'src/main.rs' },
      files: [{
        file: 'src/main.rs',
        patch: '@@ -1 +1 @@\n-old\n+new',
        additions: 1,
        deletions: 1,
      }],
      diagnostics: [{
        file: 'src/main.rs',
        line: 5,
        column: 9,
        message: 'expected `;`',
        severity: 'error' as const,
      }],
      loaded: ['AGENTS.md'],
      exitCode: 0,
    },
  };
  const native: NativeAgentTranscriptState = {
    sessionId: 'session-1',
    agent: 'opencode',
    revision: 1,
    status: 'live',
    messages: [{
      id: 'assistant:1',
      role: 'assistant',
      parts: [tool],
      diffs: tool.state.files,
    }],
    turns: [{
      id: 'turn:1',
      assistantMessageIds: ['assistant:1'],
      status: 'idle',
      diffs: tool.state.files,
    }],
  };

  const state = agentChatStateFromNative(native);
  const part = state.transcript.messages[0].parts[0];

  expect(part).toBe(tool);
  expect(part).toMatchObject({
    type: 'tool',
    state: {
      input: { path: 'src/main.rs' },
      files: [{ file: 'src/main.rs', additions: 1, deletions: 1 }],
      diagnostics: [{ file: 'src/main.rs', line: 5, column: 9 }],
      loaded: ['AGENTS.md'],
      exitCode: 0,
    },
  });
  expect(state.transcript.turns[0].assistants[0]).toBe(native.messages[0]);
});
