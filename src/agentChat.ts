export type AgentToolKind = 'command' | 'file' | 'mcp' | 'web' | 'other';
export type AgentToolStatus = 'running' | 'done' | 'failed';

export type AgentChatItem =
  | { id: string; type: 'user-message'; text: string; timestamp?: string }
  | { id: string; type: 'assistant-message'; text: string; timestamp?: string }
  | { id: string; type: 'reasoning-summary'; text: string; timestamp?: string }
  | {
      id: string;
      type: 'tool';
      toolKind: AgentToolKind;
      title: string;
      status: AgentToolStatus;
      detail?: string;
      output?: string;
      diff?: string;
      timestamp?: string;
    }
  | { id: string; type: 'plan'; text: string; timestamp?: string }
  | { id: string; type: 'notice'; text: string; timestamp?: string };

export type AgentChatConnectionStatus = 'loading' | 'live' | 'stale' | 'unavailable' | 'error';

export interface AgentChatState {
  sessionId: string;
  items: readonly AgentChatItem[];
  status: AgentChatConnectionStatus;
  error?: string;
}
