import {
  projectTranscriptTurns,
  timestamp,
  type AgentTranscript,
  type JsonObject,
  type TranscriptFileDiff,
  type TranscriptFilePart,
  type TranscriptMessage,
  type TranscriptPart,
  type TranscriptTokens,
  type TranscriptToolStatus,
} from '../agentChat';
import { shellQuote } from './shell';

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function printable(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function decodedObject(value: unknown): JsonObject | null {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return null; }
}

function diffs(value: unknown): TranscriptFileDiff[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const entry = object(item);
    const file = string(entry?.file);
    if (!entry || !file) return [];
    return [{
      file,
      patch: string(entry.patch),
      before: string(entry.before),
      after: string(entry.after),
      additions: finite(entry.additions),
      deletions: finite(entry.deletions),
    }];
  });
}

function tokens(value: unknown): TranscriptTokens | undefined {
  const entry = object(value);
  if (!entry) return undefined;
  const cache = object(entry.cache);
  const result: TranscriptTokens = {
    total: finite(entry.total),
    input: finite(entry.input),
    output: finite(entry.output),
    reasoning: finite(entry.reasoning),
    cacheRead: finite(cache?.read),
    cacheWrite: finite(cache?.write),
  };
  return Object.values(result).some(item => item !== undefined) ? result : undefined;
}

function filePart(value: JsonObject, fallbackId: string): TranscriptFilePart {
  return {
    id: string(value.id) || fallbackId,
    type: 'file',
    mime: string(value.mime),
    url: string(value.url),
    filename: string(value.filename),
    source: object(value.source) || undefined,
  };
}

function toolStatus(value: unknown): TranscriptToolStatus {
  if (value === 'pending' || value === 'running' || value === 'completed' || value === 'error') return value;
  return 'pending';
}

function part(value: unknown, index: number): TranscriptPart | null {
  const entry = object(value);
  const originalType = string(entry?.type);
  if (!entry || !originalType) return null;
  const id = string(entry.id) || `part:${index}`;
  const time = object(entry.time);
  const partTimestamp = timestamp(time?.start) ?? timestamp(entry.timestamp);

  if (originalType === 'text') {
    return {
      id,
      type: 'text',
      text: string(entry.text) || '',
      synthetic: entry.synthetic === true,
      ignored: entry.ignored === true,
      metadata: object(entry.metadata) || undefined,
      timestamp: partTimestamp,
    };
  }
  if (originalType === 'reasoning') {
    return {
      id,
      type: 'reasoning',
      text: string(entry.text) || '',
      metadata: object(entry.metadata) || undefined,
      timestamp: partTimestamp,
    };
  }
  if (originalType === 'file') return { ...filePart(entry, id), timestamp: partTimestamp };
  if (originalType === 'agent') {
    return {
      id,
      type: 'agent',
      name: string(entry.name) || string(entry.agent) || 'agent',
      source: object(entry.source) || undefined,
      timestamp: partTimestamp,
    };
  }
  if (originalType === 'tool') {
    const state = object(entry.state) || {};
    const stateTime = object(state.time);
    const attachments = Array.isArray(state.attachments)
      ? state.attachments.flatMap((attachment, attachmentIndex) => {
        const file = object(attachment);
        return file ? [filePart(file, `${id}:attachment:${attachmentIndex}`)] : [];
      })
      : undefined;
    return {
      id,
      type: 'tool',
      callId: string(entry.callID) || id,
      tool: string(entry.tool) || 'tool',
      metadata: object(entry.metadata) || undefined,
      timestamp: timestamp(stateTime?.start) ?? partTimestamp,
      state: {
        status: toolStatus(state.status),
        input: object(state.input) || {},
        output: printable(state.output),
        error: printable(state.error),
        title: string(state.title),
        metadata: object(state.metadata) || undefined,
        time: stateTime ? {
          start: timestamp(stateTime.start),
          end: timestamp(stateTime.end),
          compacted: timestamp(stateTime.compacted),
        } : undefined,
        attachments,
      },
    };
  }
  if (originalType === 'compaction') {
    return {
      id,
      type: 'compaction',
      automatic: entry.auto === true || entry.automatic === true,
      tailStartId: string(entry.tail_start_id) || string(entry.tailStartID),
      timestamp: partTimestamp,
    };
  }
  if (originalType === 'step-start') {
    return { id, type: 'step-start', snapshot: string(entry.snapshot), timestamp: partTimestamp };
  }
  if (originalType === 'step-finish') {
    return {
      id,
      type: 'step-finish',
      reason: string(entry.reason),
      cost: finite(entry.cost),
      tokens: tokens(entry.tokens),
      snapshot: string(entry.snapshot),
      timestamp: partTimestamp,
    };
  }
  if (originalType === 'patch') {
    return {
      id,
      type: 'patch',
      hash: string(entry.hash),
      files: strings(entry.files),
      timestamp: partTimestamp,
    };
  }
  if (originalType === 'snapshot') {
    return { id, type: 'snapshot', snapshot: string(entry.snapshot), timestamp: partTimestamp };
  }
  if (originalType === 'subtask') {
    return {
      id,
      type: 'subtask',
      prompt: string(entry.prompt),
      description: string(entry.description),
      command: string(entry.command),
      agent: string(entry.agent),
      timestamp: partTimestamp,
    };
  }
  return { id, type: 'unknown', originalType, data: entry, timestamp: partTimestamp };
}

function message(value: unknown, index: number): TranscriptMessage | null {
  const wrapper = object(value);
  const info = object(wrapper?.info);
  const role = info?.role;
  const id = string(info?.id);
  if (!wrapper || !info || !id || (role !== 'user' && role !== 'assistant')) return null;
  const time = object(info.time);
  const summary = object(info.summary);
  return {
    id,
    role,
    parentId: string(info.parentID),
    createdAt: timestamp(time?.created),
    completedAt: timestamp(time?.completed),
    agent: string(info.agent),
    providerId: string(info.providerID),
    modelId: string(info.modelID) || string(object(info.model)?.modelID),
    mode: string(info.mode),
    error: object(info.error) || undefined,
    summary: summary ? {
      title: string(summary.title),
      body: string(summary.body),
      diffs: diffs(summary.diffs),
    } : undefined,
    parts: Array.isArray(wrapper.parts)
      ? wrapper.parts.flatMap((item, partIndex) => {
        const parsed = part(item, index * 1000 + partIndex);
        return parsed ? [parsed] : [];
      })
      : [],
  };
}

function sessionInfo(info: JsonObject) {
  const sessionTime = object(info.time);
  const sessionSummary = object(info.summary);
  return {
    id: string(info.id) || '',
    title: string(info.title),
    slug: string(info.slug),
    directory: string(info.directory),
    createdAt: timestamp(sessionTime?.created),
    updatedAt: timestamp(sessionTime?.updated),
    summary: sessionSummary ? {
      additions: finite(sessionSummary.additions),
      deletions: finite(sessionSummary.deletions),
      files: finite(sessionSummary.files),
      diffs: diffs(sessionSummary.diffs),
    } : undefined,
    raw: info,
  };
}

/** Official OpenCode CLI export command. It only reads the selected session. */
export function openCodeExportCommand(sessionId: string): string {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Invalid OpenCode session ID');
  return `opencode export ${shellQuote(sessionId)}`;
}

function validSessionId(sessionId: string): void {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Invalid OpenCode session ID');
}

/** Read the durable sequence before the initial export so no concurrent event is missed. */
export function openCodeEventCursorCommand(sessionId: string): string {
  validSessionId(sessionId);
  const query = `SELECT COALESCE(MAX(seq), 0) AS seq FROM event WHERE aggregate_id = '${sessionId}'`;
  return `opencode db ${shellQuote(query)} --format json`;
}

/** Fetch only official durable OpenCode events newer than the local cursor. */
export function openCodeEventsCommand(sessionId: string, afterSequence: number): string {
  validSessionId(sessionId);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid OpenCode event cursor');
  const query = `SELECT seq, type, data FROM event WHERE aggregate_id = '${sessionId}' AND seq > ${afterSequence} ORDER BY seq`;
  return `opencode db ${shellQuote(query)} --format json`;
}

export function parseOpenCodeEventCursor(value: unknown): number {
  const row = Array.isArray(value) ? object(value[0]) : null;
  const sequence = finite(row?.seq);
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('OpenCode returned an invalid event cursor');
  }
  return sequence;
}

export interface OpenCodeEventResult {
  transcript: AgentTranscript;
  cursor: number;
}

/** Apply official durable session/message/part events to an existing export. */
export function applyOpenCodeEvents(
  transcript: AgentTranscript,
  value: unknown,
  afterSequence: number,
): OpenCodeEventResult {
  if (!Array.isArray(value)) throw new Error('OpenCode returned invalid session events');
  let cursor = afterSequence;
  let messages = transcript.messages;
  let info = transcript.info;
  const mutableMessages = () => {
    if (messages === transcript.messages) messages = [...messages];
    return messages;
  };

  for (const rowValue of value) {
    const row = object(rowValue);
    const sequence = finite(row?.seq);
    const rawEventType = string(row?.type);
    const eventType = rawEventType?.replace(/\.\d+$/, '');
    const data = decodedObject(row?.data);
    if (!row || sequence === undefined || !Number.isSafeInteger(sequence) || sequence <= cursor || !eventType || !data) {
      throw new Error('OpenCode returned invalid session events');
    }
    cursor = sequence;

    if (eventType === 'session.created' || eventType === 'session.updated') {
      const nextInfo = object(data.info);
      if (nextInfo && string(nextInfo.id) === transcript.sessionId) info = sessionInfo(nextInfo);
      continue;
    }
    if (eventType === 'message.updated') {
      const next = message({ info: data.info, parts: [] }, 0);
      if (!next) continue;
      const index = messages.findIndex(item => item.id === next.id);
      if (index < 0) mutableMessages().push(next);
      else mutableMessages()[index] = { ...next, parts: messages[index].parts };
      continue;
    }
    if (eventType === 'message.removed') {
      const messageId = string(data.messageID);
      if (!messageId) continue;
      const index = messages.findIndex(item => item.id === messageId);
      if (index >= 0) mutableMessages().splice(index, 1);
      continue;
    }
    if (eventType === 'message.part.updated') {
      const rawPart = object(data.part);
      const messageId = string(rawPart?.messageID);
      const next = rawPart ? part(rawPart, 0) : null;
      if (!messageId || !next) continue;
      const messageIndex = messages.findIndex(item => item.id === messageId);
      if (messageIndex < 0) continue;
      const current = messages[messageIndex];
      const nextParts = [...current.parts];
      const partIndex = nextParts.findIndex(item => item.id === next.id);
      if (partIndex < 0) nextParts.push(next);
      else nextParts[partIndex] = next;
      mutableMessages()[messageIndex] = { ...current, parts: nextParts };
      continue;
    }
    if (eventType === 'message.part.removed') {
      const messageId = string(data.messageID);
      const partId = string(data.partID);
      if (!messageId || !partId) continue;
      const messageIndex = messages.findIndex(item => item.id === messageId);
      if (messageIndex < 0) continue;
      const current = messages[messageIndex];
      const nextParts = current.parts.filter(item => item.id !== partId);
      if (nextParts.length !== current.parts.length) mutableMessages()[messageIndex] = { ...current, parts: nextParts };
    }
  }

  if (messages === transcript.messages && info === transcript.info) return { transcript, cursor };
  return {
    transcript: {
      sessionId: transcript.sessionId,
      info,
      messages,
      turns: projectTranscriptTurns(messages),
    },
    cursor,
  };
}

/** Validate and project the official `{ info, messages: [{ info, parts }] }` export. */
export function parseOpenCodeTranscript(value: unknown): AgentTranscript {
  const exportData = object(value);
  const info = object(exportData?.info);
  const sessionId = string(info?.id);
  if (!exportData || !info || !sessionId || !Array.isArray(exportData.messages)) {
    throw new Error('OpenCode returned an invalid session export');
  }
  const messages = exportData.messages.flatMap((item, index) => {
    const parsed = message(item, index);
    return parsed ? [parsed] : [];
  });
  return {
    sessionId,
    info: sessionInfo(info),
    messages,
    turns: projectTranscriptTurns(messages),
  };
}
