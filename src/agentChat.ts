export type JsonObject = Record<string, unknown>;

export type TranscriptToolStatus = 'pending' | 'running' | 'completed' | 'error';

export interface TranscriptFileDiff {
  file: string;
  patch?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
}

export interface TranscriptTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface TranscriptPartBase {
  id: string;
  timestamp?: number;
}

export interface TranscriptTextPart extends TranscriptPartBase {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  metadata?: JsonObject;
}

export interface TranscriptReasoningPart extends TranscriptPartBase {
  type: 'reasoning';
  text: string;
  metadata?: JsonObject;
}

export interface TranscriptFilePart extends TranscriptPartBase {
  type: 'file';
  mime?: string;
  url?: string;
  filename?: string;
  source?: JsonObject;
}

export interface TranscriptAgentPart extends TranscriptPartBase {
  type: 'agent';
  name: string;
  source?: JsonObject;
}

export interface TranscriptToolState {
  status: TranscriptToolStatus;
  input: JsonObject;
  output?: string;
  error?: string;
  title?: string;
  metadata?: JsonObject;
  time?: {
    start?: number;
    end?: number;
    compacted?: number;
  };
  attachments?: TranscriptFilePart[];
}

export interface TranscriptToolPart extends TranscriptPartBase {
  type: 'tool';
  callId: string;
  tool: string;
  state: TranscriptToolState;
  metadata?: JsonObject;
}

export interface TranscriptCompactionPart extends TranscriptPartBase {
  type: 'compaction';
  automatic?: boolean;
  tailStartId?: string;
}

export interface TranscriptStepStartPart extends TranscriptPartBase {
  type: 'step-start';
  snapshot?: string;
}

export interface TranscriptStepFinishPart extends TranscriptPartBase {
  type: 'step-finish';
  reason?: string;
  cost?: number;
  tokens?: TranscriptTokens;
  snapshot?: string;
}

export interface TranscriptPatchPart extends TranscriptPartBase {
  type: 'patch';
  hash?: string;
  files: string[];
}

export interface TranscriptSnapshotPart extends TranscriptPartBase {
  type: 'snapshot';
  snapshot?: string;
}

export interface TranscriptSubtaskPart extends TranscriptPartBase {
  type: 'subtask';
  prompt?: string;
  description?: string;
  command?: string;
  agent?: string;
}

export interface TranscriptPlanPart extends TranscriptPartBase {
  type: 'plan';
  text: string;
}

export interface TranscriptNoticePart extends TranscriptPartBase {
  type: 'notice';
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface TranscriptUnknownPart extends TranscriptPartBase {
  type: 'unknown';
  originalType: string;
  data: JsonObject;
}

export type TranscriptPart =
  | TranscriptTextPart
  | TranscriptReasoningPart
  | TranscriptFilePart
  | TranscriptAgentPart
  | TranscriptToolPart
  | TranscriptCompactionPart
  | TranscriptStepStartPart
  | TranscriptStepFinishPart
  | TranscriptPatchPart
  | TranscriptSnapshotPart
  | TranscriptSubtaskPart
  | TranscriptPlanPart
  | TranscriptNoticePart
  | TranscriptUnknownPart;

export interface TranscriptMessageSummary {
  title?: string;
  body?: string;
  diffs: TranscriptFileDiff[];
}

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  parentId?: string;
  createdAt?: number;
  completedAt?: number;
  agent?: string;
  providerId?: string;
  modelId?: string;
  mode?: string;
  error?: JsonObject;
  summary?: TranscriptMessageSummary;
  parts: TranscriptPart[];
}

export interface TranscriptTurn {
  id: string;
  user?: TranscriptMessage;
  assistants: TranscriptMessage[];
  status: 'idle' | 'working' | 'interrupted' | 'error';
  startedAt?: number;
  completedAt?: number;
  cost?: number;
  tokens?: TranscriptTokens;
  diffs: TranscriptFileDiff[];
}

export interface TranscriptSessionInfo {
  id: string;
  title?: string;
  slug?: string;
  directory?: string;
  createdAt?: number;
  updatedAt?: number;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
    diffs: TranscriptFileDiff[];
  };
  raw?: JsonObject;
}

export interface AgentTranscript {
  sessionId: string;
  info?: TranscriptSessionInfo;
  messages: TranscriptMessage[];
  turns: TranscriptTurn[];
}

export type AgentChatConnectionStatus = 'loading' | 'live' | 'stale' | 'unavailable' | 'error';

export interface AgentChatState {
  sessionId: string;
  transcript: AgentTranscript;
  status: AgentChatConnectionStatus;
  error?: string;
}

export function emptyTranscript(sessionId: string): AgentTranscript {
  return { sessionId, messages: [], turns: [] };
}

function mergeTokens(target: TranscriptTokens, source: TranscriptTokens | undefined): void {
  if (!source) return;
  for (const key of ['total', 'input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'] as const) {
    const value = source[key];
    if (value !== undefined) target[key] = (target[key] || 0) + value;
  }
}

function messageInterrupted(message: TranscriptMessage): boolean {
  const name = typeof message.error?.name === 'string' ? message.error.name : '';
  return /abort|interrupt/i.test(name);
}

/** Project OpenCode-style messages into the user-turn timeline consumed by the UI. */
export function projectTranscriptTurns(messages: readonly TranscriptMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const byUser = new Map<string, TranscriptTurn>();
  let latest: TranscriptTurn | undefined;

  for (const message of messages) {
    if (message.role === 'user') {
      latest = {
        id: message.id,
        user: message,
        assistants: [],
        status: 'idle',
        startedAt: message.createdAt,
        completedAt: message.completedAt,
        diffs: message.summary?.diffs || [],
      };
      turns.push(latest);
      byUser.set(message.id, latest);
      continue;
    }

    let turn = message.parentId ? byUser.get(message.parentId) : undefined;
    if (!turn) turn = latest;
    if (!turn || (turn.user && message.parentId && turn.user.id !== message.parentId)) {
      turn = {
        id: message.parentId || message.id,
        assistants: [],
        status: 'idle',
        startedAt: message.createdAt,
        diffs: [],
      };
      turns.push(turn);
      if (message.parentId) byUser.set(message.parentId, turn);
    }
    latest = turn;
    turn.assistants.push(message);
    turn.startedAt ??= message.createdAt;
    if (message.completedAt !== undefined) {
      turn.completedAt = Math.max(turn.completedAt || 0, message.completedAt);
    }
  }

  for (const turn of turns) {
    const tokens: TranscriptTokens = {};
    let hasTokens = false;
    let cost = 0;
    let hasCost = false;
    let running = false;
    let failed = false;
    let interrupted = false;
    for (const message of turn.assistants) {
      failed ||= Boolean(message.error) && !messageInterrupted(message);
      interrupted ||= messageInterrupted(message);
      for (const part of message.parts) {
        if (part.type === 'tool') {
          running ||= part.state.status === 'pending' || part.state.status === 'running';
          failed ||= part.state.status === 'error';
          if (part.state.time?.end !== undefined) {
            turn.completedAt = Math.max(turn.completedAt || 0, part.state.time.end);
          }
        }
        if (part.type !== 'step-finish') continue;
        if (part.cost !== undefined) {
          cost += part.cost;
          hasCost = true;
        }
        if (part.tokens) {
          mergeTokens(tokens, part.tokens);
          hasTokens = true;
        }
      }
    }
    turn.cost = hasCost ? cost : undefined;
    turn.tokens = hasTokens ? tokens : undefined;
    turn.status = failed ? 'error' : interrupted ? 'interrupted' : running ? 'working' : 'idle';
  }
  return turns;
}

export function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

/** Preserve unchanged message and turn references when a source publishes a newer snapshot. */
export function reconcileTranscript(previous: AgentTranscript, incoming: AgentTranscript): AgentTranscript {
  if (previous.sessionId !== incoming.sessionId) return incoming;
  const oldMessages = new Map(previous.messages.map(message => [message.id, message]));
  const messages = incoming.messages.map(message => {
    const old = oldMessages.get(message.id);
    return old && sameValue(old, message) ? old : message;
  });
  const projected = projectTranscriptTurns(messages);
  const oldTurns = new Map(previous.turns.map(turn => [turn.id, turn]));
  const turns = projected.map(turn => {
    const old = oldTurns.get(turn.id);
    return old && sameValue(old, turn) ? old : turn;
  });
  const info = sameValue(previous.info, incoming.info) ? previous.info : incoming.info;
  if (
    info === previous.info
    && messages.length === previous.messages.length
    && messages.every((message, index) => message === previous.messages[index])
    && turns.length === previous.turns.length
    && turns.every((turn, index) => turn === previous.turns[index])
  ) return previous;
  return { sessionId: incoming.sessionId, info, messages, turns };
}
