import {
  projectTranscriptTurns,
  timestamp,
  type AgentTranscript,
  type JsonObject,
  type TranscriptMessage,
  type TranscriptPart,
  type TranscriptToolPart,
  type TranscriptToolStatus,
} from '../agentChat';

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => {
      const entry = object(item);
      return string(entry?.text) || string(entry?.content) || '';
    }).filter(Boolean).join('\n');
  }
  const entry = object(value);
  if (!entry) return '';
  if (typeof entry.content === 'string') return entry.content;
  if (Array.isArray(entry.content_items)) return textContent(entry.content_items);
  if (Array.isArray(entry.content)) return textContent(entry.content);
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function isInjectedUserContext(value: string): boolean {
  const text = value.trimStart();
  return (
    /^# AGENTS\.md instructions for [^\n]+\n\n<INSTRUCTIONS>/i.test(text)
    || /^<environment_context>[\s\S]*<\/environment_context>$/i.test(text)
  );
}

function detail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function input(value: unknown): JsonObject {
  const direct = object(value);
  if (direct) return direct;
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) || { raw: value }; } catch { return { raw: value }; }
  }
  return value === undefined ? {} : { value };
}

function commandTitle(command: unknown): string {
  if (Array.isArray(command)) return command.filter(part => typeof part === 'string').join(' ');
  return string(command) || 'Command';
}

function status(value: unknown, fallback: TranscriptToolStatus): TranscriptToolStatus {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (/fail|error|declin|incomplete/.test(normalized)) return 'error';
  if (/complete|done|success/.test(normalized)) return 'completed';
  if (/running|progress/.test(normalized)) return 'running';
  if (/pending|queued/.test(normalized)) return 'pending';
  return fallback;
}

function formatPlan(payload: JsonObject): string {
  const explanation = string(payload.explanation);
  const steps = Array.isArray(payload.plan)
    ? payload.plan.map(item => {
      const entry = object(item);
      const step = string(entry?.step);
      if (!step) return '';
      const marker = entry?.status === 'completed' ? 'x' : ' ';
      return `- [${marker}] ${step}`;
    }).filter(Boolean)
    : [];
  return [explanation, ...steps].filter(Boolean).join('\n\n');
}

interface MessageSignature {
  id: string;
  sequence: number;
}

interface ToolLocation {
  messageId: string;
  partId: string;
}

/** Codex rollout knowledge. React consumes only the OpenCode-shaped transcript. */
export class CodexRolloutAdapter {
  private readonly messages: TranscriptMessage[] = [];
  private readonly messageIndexes = new Map<string, number>();
  private readonly tools = new Map<string, ToolLocation>();
  private readonly recentMessages = new Map<string, MessageSignature>();
  private sequence = 0;
  private sessionId = 'codex';
  private sessionDirectory: string | undefined;
  private activeUserMessageId: string | undefined;
  private activeAssistantMessageId: string | undefined;

  constructor(sessionId = 'codex') {
    this.sessionId = sessionId;
  }

  snapshot(): AgentTranscript {
    const messages = this.messages.map(message => ({
      ...message,
      parts: message.parts.map(part => (
        part.type === 'tool'
          ? { ...part, state: { ...part.state, input: { ...part.state.input } } }
          : { ...part }
      )) as TranscriptPart[],
    }));
    return {
      sessionId: this.sessionId,
      info: {
        id: this.sessionId,
        directory: this.sessionDirectory,
      },
      messages,
      turns: projectTranscriptTurns(messages),
    };
  }

  accept(recordValue: unknown): void {
    const record = object(recordValue);
    const recordType = string(record?.type);
    if (!record || !recordType) return;
    this.sequence += 1;
    const at = timestamp(record.timestamp);

    if (recordType === 'session_meta') {
      const payload = object(record.payload);
      this.sessionId = string(payload?.id) || this.sessionId;
      this.sessionDirectory = string(payload?.cwd) || this.sessionDirectory;
      return;
    }
    if (recordType === 'thread.started') {
      this.sessionId = string(record.thread_id) || string(object(record.thread)?.id) || this.sessionId;
      return;
    }
    if (recordType === 'item.completed') {
      const item = object(record.item);
      if (item) this.acceptCompletedItem(item, at);
      return;
    }

    const payload = object(record.payload);
    if (!payload) return;
    if (recordType === 'response_item') this.acceptResponse(payload, at);
    if (recordType === 'event_msg') this.acceptEvent(payload, at);
  }

  private putMessage(message: TranscriptMessage): void {
    const index = this.messageIndexes.get(message.id);
    if (index === undefined) {
      this.messageIndexes.set(message.id, this.messages.length);
      this.messages.push(message);
    } else {
      this.messages[index] = { ...this.messages[index], ...message };
    }
  }

  private getMessage(id: string | undefined): TranscriptMessage | undefined {
    if (!id) return undefined;
    const index = this.messageIndexes.get(id);
    return index === undefined ? undefined : this.messages[index];
  }

  private beginTurn(): void {
    this.activeUserMessageId = undefined;
    this.activeAssistantMessageId = undefined;
  }

  private userMessage(text: string, id: string, at?: number): void {
    const normalized = text.trim();
    if (!normalized || isInjectedUserContext(normalized)) return;
    const signature = `user\n${normalized}`;
    const recent = this.recentMessages.get(signature);
    if (recent && this.sequence - recent.sequence <= 4) {
      recent.sequence = this.sequence;
      this.activeUserMessageId = recent.id;
      return;
    }
    const messageId = `user:${id}`;
    this.recentMessages.set(signature, { id: messageId, sequence: this.sequence });
    this.putMessage({
      id: messageId,
      role: 'user',
      createdAt: at,
      parts: [{ id: `${messageId}:text`, type: 'text', text: normalized, timestamp: at }],
    });
    this.activeUserMessageId = messageId;
    this.activeAssistantMessageId = undefined;
  }

  private assistantMessage(at?: number): TranscriptMessage {
    const existing = this.getMessage(this.activeAssistantMessageId);
    if (existing) return existing;
    const id = `assistant:${this.activeUserMessageId || this.sequence}`;
    const existingForTurn = this.getMessage(id);
    if (existingForTurn) {
      this.activeAssistantMessageId = id;
      return existingForTurn;
    }
    const message: TranscriptMessage = {
      id,
      role: 'assistant',
      parentId: this.activeUserMessageId,
      createdAt: at,
      parts: [],
    };
    this.putMessage(message);
    this.activeAssistantMessageId = id;
    return this.getMessage(id)!;
  }

  private assistantText(text: string, id: string, at?: number, reasoning = false): void {
    const normalized = text.trim();
    if (!normalized) return;
    const signature = `${reasoning ? 'reasoning' : 'assistant'}\n${normalized}`;
    const recent = this.recentMessages.get(signature);
    if (recent && this.sequence - recent.sequence <= 4) {
      recent.sequence = this.sequence;
      return;
    }
    const message = this.assistantMessage(at);
    const partId = `${reasoning ? 'reasoning' : 'text'}:${id}`;
    this.recentMessages.set(signature, { id: partId, sequence: this.sequence });
    message.parts.push(reasoning
      ? { id: partId, type: 'reasoning', text: normalized, timestamp: at }
      : { id: partId, type: 'text', text: normalized, timestamp: at });
  }

  private putPart(part: TranscriptPart, at?: number): void {
    const message = this.assistantMessage(at);
    const index = message.parts.findIndex(item => item.id === part.id);
    if (index < 0) message.parts.push(part);
    else message.parts[index] = part;
  }

  private tool(
    id: string,
    name: string,
    toolStatus: TranscriptToolStatus,
    toolInput?: JsonObject,
    output?: string,
    error?: string,
    metadata?: JsonObject,
    at?: number,
  ): void {
    const key = `tool:${id}`;
    const location = this.tools.get(key);
    const message = location ? this.getMessage(location.messageId) : this.assistantMessage(at);
    const existing = message?.parts.find((item): item is TranscriptToolPart => item.id === key && item.type === 'tool');
    const part: TranscriptToolPart = {
      id: key,
      type: 'tool',
      callId: id,
      tool: name || existing?.tool || 'tool',
      timestamp: existing?.timestamp ?? at,
      state: {
        status: toolStatus,
        input: toolInput || existing?.state.input || {},
        output: output ?? existing?.state.output,
        error: error ?? existing?.state.error,
        title: existing?.state.title,
        metadata: metadata || existing?.state.metadata,
        time: {
          start: existing?.state.time?.start ?? at,
          end: toolStatus === 'completed' || toolStatus === 'error' ? at : existing?.state.time?.end,
        },
      },
    };
    if (!message) return;
    const index = message.parts.findIndex(item => item.id === key);
    if (index < 0) message.parts.push(part);
    else message.parts[index] = part;
    this.tools.set(key, { messageId: message.id, partId: key });
  }

  private acceptCompletedItem(item: JsonObject, at?: number): void {
    const type = string(item.type) || '';
    const id = string(item.id) || `${this.sequence}`;
    if (type === 'message' && item.role === 'user') {
      this.userMessage(textContent(item.content), id, at);
      return;
    }
    if (type === 'agent_message') {
      this.assistantText(string(item.text) || '', id, at);
      return;
    }
    if (type === 'reasoning') {
      this.assistantText(string(item.text) || textContent(item.summary), id, at, true);
      return;
    }
    if (type === 'command_execution') {
      const command = commandTitle(item.command);
      this.tool(id, 'exec_command', finiteStatus(item.exit_code), { command }, string(item.aggregated_output), undefined, { exitCode: item.exit_code }, at);
      return;
    }
    if (type === 'function_call') {
      const name = string(item.name) || 'tool';
      this.tool(id, name, status(item.status, 'completed'), input(item.arguments), string(item.output), undefined, undefined, at);
    }
  }

  private acceptResponse(payload: JsonObject, at?: number): void {
    const type = string(payload.type) || '';
    const itemId = string(payload.id) || `${this.sequence}`;
    const callId = string(payload.call_id) || itemId;
    if (type === 'message') {
      const content = textContent(payload.content);
      if (payload.role === 'assistant') this.assistantText(content, itemId, at, payload.phase === 'commentary');
      if (payload.role === 'user') this.userMessage(content, itemId, at);
      return;
    }
    if (type === 'reasoning') {
      this.assistantText(textContent(payload.summary), itemId, at, true);
      return;
    }
    if (type === 'local_shell_call') {
      const action = object(payload.action);
      this.tool(callId, 'exec_command', status(payload.status, 'running'), action || {}, undefined, undefined, undefined, at);
      return;
    }
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      const name = string(payload.name) || string(payload.execution) || 'tool';
      const raw = payload.arguments ?? payload.input;
      this.tool(callId, name, status(payload.status, 'running'), input(raw), undefined, undefined, undefined, at);
      return;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const location = this.tools.get(`tool:${callId}`);
      const message = location ? this.getMessage(location.messageId) : undefined;
      const current = message?.parts.find((item): item is TranscriptToolPart => item.id === `tool:${callId}` && item.type === 'tool');
      this.tool(callId, current?.tool || string(payload.name) || 'tool', 'completed', current?.state.input, textContent(payload.output), undefined, current?.state.metadata, at);
      return;
    }
    if (type === 'web_search_call') {
      const action = object(payload.action) || {};
      this.tool(callId, 'websearch', status(payload.status, 'running'), action, undefined, undefined, undefined, at);
    }
  }

  private acceptEvent(payload: JsonObject, at?: number): void {
    const type = string(payload.type) || '';
    const callId = string(payload.call_id) || `${this.sequence}`;
    if (type === 'task_started') {
      this.beginTurn();
      return;
    }
    if (type === 'task_complete') {
      const assistant = this.getMessage(this.activeAssistantMessageId);
      if (assistant) assistant.completedAt = at;
      this.activeAssistantMessageId = undefined;
      this.activeUserMessageId = undefined;
      return;
    }
    if (type === 'user_message') {
      this.userMessage(string(payload.message) || '', `event:${callId}`, at);
      return;
    }
    if (type === 'agent_message') {
      this.assistantText(string(payload.message) || '', `event:${callId}`, at);
      return;
    }
    if (type === 'agent_reasoning') {
      this.assistantText(string(payload.text) || '', `event:${callId}`, at, true);
      return;
    }
    if (type === 'exec_command_begin') {
      this.tool(callId, 'exec_command', 'running', {
        command: commandTitle(payload.command),
        ...(string(payload.cwd) ? { cwd: string(payload.cwd) } : {}),
      }, undefined, undefined, undefined, at);
      return;
    }
    if (type === 'exec_command_output_delta') return;
    if (type === 'exec_command_end') {
      const output = string(payload.aggregated_output)
        || [string(payload.stdout), string(payload.stderr)].filter(Boolean).join('\n');
      const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : undefined;
      this.tool(callId, 'exec_command', status(payload.status, exitCode === 0 ? 'completed' : 'error'), {
        command: commandTitle(payload.command),
        ...(string(payload.cwd) ? { cwd: string(payload.cwd) } : {}),
      }, output, exitCode && exitCode !== 0 ? `Exited with code ${exitCode}` : undefined, { exitCode }, at);
      return;
    }
    if (type === 'patch_apply_begin' || type === 'patch_apply_updated') {
      this.tool(callId, 'apply_patch', 'running', { changes: payload.changes }, undefined, undefined, undefined, at);
      return;
    }
    if (type === 'patch_apply_end') {
      const output = [string(payload.stdout), string(payload.stderr)].filter(Boolean).join('\n');
      this.tool(callId, 'apply_patch', payload.success === false ? 'error' : status(payload.status, 'completed'), { changes: payload.changes }, output, payload.success === false ? output || 'Patch failed' : undefined, undefined, at);
      return;
    }
    if (type === 'turn_diff') {
      this.tool(`diff:${this.sequence}`, 'turn_diff', 'completed', {}, undefined, undefined, { unifiedDiff: string(payload.unified_diff) }, at);
      return;
    }
    if (type === 'mcp_tool_call_begin' || type === 'mcp_tool_call_end') {
      const invocation = object(payload.invocation) || {};
      const name = [string(invocation.server), string(invocation.tool)].filter(Boolean).join(' · ') || 'mcp';
      const result = object(payload.result);
      this.tool(callId, name, type.endsWith('_end') ? (result?.Err ? 'error' : 'completed') : 'running', input(invocation.arguments), type.endsWith('_end') ? detail(payload.result) : undefined, result?.Err ? detail(result.Err) : undefined, undefined, at);
      return;
    }
    if (type === 'web_search_begin' || type === 'web_search_end') {
      this.tool(callId, 'websearch', type.endsWith('_end') ? 'completed' : 'running', {
        query: string(payload.query) || '',
        ...(object(payload.action) || {}),
      }, undefined, undefined, undefined, at);
      return;
    }
    if (type === 'plan_update') {
      const text = formatPlan(payload);
      if (text) this.putPart({ id: `plan:${this.sequence}`, type: 'plan', text, timestamp: at }, at);
      return;
    }
    if (type === 'error' || type === 'warning' || type === 'stream_error' || type === 'deprecation_notice') {
      const text = string(payload.message) || string(payload.summary) || detail(payload) || type;
      this.putPart({ id: `notice:${this.sequence}`, type: 'notice', level: type === 'warning' || type === 'deprecation_notice' ? 'warning' : 'error', text, timestamp: at }, at);
      return;
    }
    if (/approval_request|request_user_input|elicitation_request|request_permissions/.test(type)) {
      this.putPart({ id: `notice:${this.sequence}`, type: 'notice', level: 'info', text: 'Codex is waiting for an interactive response. Open Terminal to respond.', timestamp: at }, at);
    }
  }
}

function finiteStatus(value: unknown): TranscriptToolStatus {
  return typeof value === 'number' && value !== 0 ? 'error' : 'completed';
}
