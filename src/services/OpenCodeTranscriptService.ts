import { agentChatCache, type AgentChatCache } from './agentChatCache';
import { NativeTranscriptService } from './CodexTranscriptService';

/** Thin React listener/cache facade; OpenCode export and DB events live in Rust. */
export class OpenCodeTranscriptService extends NativeTranscriptService {
  constructor(cache: AgentChatCache = agentChatCache) {
    super('opencode', cache);
  }
}

export const openCodeTranscriptService = new OpenCodeTranscriptService();
