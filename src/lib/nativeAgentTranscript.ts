import type { NativeAgentTranscriptPart, NativeAgentTranscriptState } from 'react-native-whip-ssh';

import type {
  AgentChatState,
  AgentTranscript,
  JsonObject,
  TranscriptMessage,
  TranscriptPart,
  TranscriptTurn,
} from '../agentChat';

function part(value: NativeAgentTranscriptPart): TranscriptPart {
  if (value.type === 'text' || value.type === 'reasoning' || value.type === 'plan') {
    return { id: value.id, type: value.type, text: value.text, timestamp: value.timestamp };
  }
  if (value.type === 'notice') {
    return { id: value.id, type: 'notice', level: value.level, text: value.text, timestamp: value.timestamp };
  }
  const metadata: JsonObject | undefined = value.state.files.length
    ? { files: value.state.files.map(file => ({ ...file, filePath: file.file, relativePath: file.file })) }
    : value.state.exitCode === undefined ? undefined : { exitCode: value.state.exitCode };
  return {
    id: value.id,
    type: 'tool',
    callId: value.callId,
    tool: value.tool,
    timestamp: value.timestamp,
    state: {
      status: value.state.status,
      input: { ...value.state.input },
      output: value.state.output,
      error: value.state.error,
      title: value.state.title,
      metadata,
      time: { start: value.state.startedAt, end: value.state.completedAt },
    },
  };
}

/** Mechanical typed-FFI projection into the existing presentation model. */
export function agentChatStateFromNative(value: NativeAgentTranscriptState): AgentChatState {
  const messages: TranscriptMessage[] = value.messages.map(message => ({
    id: message.id,
    role: message.role,
    parentId: message.parentId,
    createdAt: message.createdAt,
    completedAt: message.completedAt,
    error: message.error ? { message: message.error } : undefined,
    summary: message.diffs.length ? { diffs: message.diffs } : undefined,
    parts: message.parts.map(part),
  }));
  const byId = new Map(messages.map(message => [message.id, message]));
  const turns: TranscriptTurn[] = value.turns.map(turn => ({
    id: turn.id,
    user: turn.userMessageId ? byId.get(turn.userMessageId) : undefined,
    assistants: turn.assistantMessageIds.flatMap(id => {
      const message = byId.get(id);
      return message ? [message] : [];
    }),
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    diffs: turn.diffs,
  }));
  const transcript: AgentTranscript = {
    sessionId: value.sessionId,
    info: value.info ? {
      id: value.info.id,
      title: value.info.title,
      directory: value.info.directory,
      createdAt: value.info.createdAt,
      updatedAt: value.info.updatedAt,
    } : undefined,
    messages,
    turns,
  };
  return {
    sessionId: value.sessionId,
    transcript,
    revision: value.revision,
    status: value.status === 'closed' ? 'unavailable' : value.status,
    error: value.error,
  };
}
