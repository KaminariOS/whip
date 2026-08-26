import type { NativeAgentTranscriptState, NativeAgentTranscriptUpdate } from 'react-native-whip-ssh';

import { agentChatCache, type AgentChatCache } from './agentChatCache';
import {
  NativeTranscriptService,
  type NativeTranscriptTransport,
} from './CodexTranscriptService';

export interface OpenCodeTranscriptTransport extends NativeTranscriptTransport {
  openOpenCodeAgentTranscript(
    terminalId: string,
    sessionId: string,
    cacheBlob: ArrayBuffer | undefined,
    handler: (event: NativeAgentTranscriptUpdate) => void,
  ): { key: string; state: NativeAgentTranscriptState };
}

/** Thin React listener/cache facade; OpenCode export and DB events live in Rust. */
export class OpenCodeTranscriptService extends NativeTranscriptService<OpenCodeTranscriptTransport> {
  constructor(cache: AgentChatCache = agentChatCache) {
    super(
      'opencode',
      (transport, terminalId, sessionId, cacheBlob, handler) => transport.openOpenCodeAgentTranscript(
        terminalId,
        sessionId,
        cacheBlob,
        handler,
      ),
      cache,
    );
  }

  /** HostRuntime polls and reconnects natively; foreground hints need no JS work. */
  refresh(_key: string): void {}
}

export const openCodeTranscriptService = new OpenCodeTranscriptService();
