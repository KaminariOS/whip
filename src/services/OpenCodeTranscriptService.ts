import type { NativeAgentTranscriptState, NativeAgentTranscriptUpdate } from 'react-native-whip-ssh';

import { agentChatCache, type AgentChatCache } from './agentChatCache';
import {
  NativeTranscriptService,
  type NativeTranscriptTransport,
} from './CodexTranscriptService';

export interface OpenCodeTranscriptTransport extends NativeTranscriptTransport {
  bindOpenCodeAgentTranscript(
    terminalId: string,
    sessionId: string,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState };
}

/** Thin React listener/cache facade; OpenCode export and DB events live in Rust. */
export class OpenCodeTranscriptService extends NativeTranscriptService<OpenCodeTranscriptTransport> {
  constructor(cache: AgentChatCache = agentChatCache) {
    super(
      'opencode',
      (transport, terminalId, sessionId, handler) => transport.bindOpenCodeAgentTranscript(
        terminalId,
        sessionId,
        handler,
      ),
      cache,
    );
  }
}

export const openCodeTranscriptService = new OpenCodeTranscriptService();
