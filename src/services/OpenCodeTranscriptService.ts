import { agentChatCache, type AgentChatCache } from './agentChatCache';
import {
  NativeTranscriptService,
  agentTranscriptService,
} from './CodexTranscriptService';

/** @deprecated Agent identity is resolved by Rust; kept as a test-compatible name. */
export class OpenCodeTranscriptService extends NativeTranscriptService {
  constructor(cache: AgentChatCache = agentChatCache) {
    super(cache);
  }
}

export const openCodeTranscriptService = agentTranscriptService;
