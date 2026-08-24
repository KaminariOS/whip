import {
  projectTranscriptTurns,
  timestamp,
  type AgentTranscript,
  type JsonObject,
  type TranscriptFileDiff,
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

function canonicalToolName(value: string): string {
  const name = value.toLowerCase();
  if (/^(?:exec|exec_command|command_execution|local_shell_call|bash)$/.test(name)) return 'shell';
  if (/^(?:apply_patch|turn_diff)$/.test(name)) return 'patch';
  if (/^(?:web_search|web_search_call)$/.test(name)) return 'websearch';
  if (name === 'update_plan') return 'todowrite';
  return name || 'tool';
}

function decodedStringLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as string; } catch { return undefined; }
}

function objectString(source: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:["']?${escaped}["']?)\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 's'));
  return decodedStringLiteral(match?.[1]);
}

function objectNumber(source: string, key: string): number | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:["']?${escaped}["']?)\\s*:\\s*(-?\\d+)`));
  return match ? Number(match[1]) : undefined;
}

function applyPatchSource(source: string): string | undefined {
  const literals = source.match(/"(?:\\.|[^"\\])*"/gs) || [];
  return literals.map(decodedStringLiteral).find(value => value?.startsWith('*** Begin Patch'));
}

function diffCounts(value: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of value.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function applyPatchFiles(value: string | undefined): JsonObject[] {
  if (!value) return [];
  const markers = [...value.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)];
  return markers.map((marker, index) => {
    const operation = marker[1].toLowerCase();
    const filePath = marker[2].trim();
    const start = (marker.index || 0) + marker[0].length + 1;
    const end = markers[index + 1]?.index ?? value.indexOf('*** End Patch', start);
    const body = value.slice(start, end < 0 ? value.length : end).trimEnd();
    const movePath = body.match(/^\*\*\* Move to: (.+)$/m)?.[1]?.trim();
    const patch = body.replace(/^\*\*\* Move to: .+\n?/m, '');
    const counts = diffCounts(patch);
    return {
      filePath,
      relativePath: filePath,
      type: movePath ? 'move' : operation,
      ...(movePath ? { movePath } : {}),
      ...(patch ? { patch } : {}),
      ...counts,
    };
  });
}

function legacyChangeFiles(value: unknown): JsonObject[] {
  const changes = object(value);
  if (!changes) return [];
  return Object.entries(changes).map(([filePath, entryValue]) => {
    const entry = object(entryValue) || {};
    const patch = string(entry.diff) || string(entry.patch);
    const counts = diffCounts(patch || '');
    return {
      filePath,
      relativePath: filePath,
      type: string(entry.type) || 'update',
      ...(patch ? { patch } : {}),
      ...(string(entry.before) ? { before: string(entry.before) } : {}),
      ...(string(entry.after) ? { after: string(entry.after) } : {}),
      ...counts,
    };
  });
}

function unifiedDiffFiles(value: string | undefined): TranscriptFileDiff[] {
  if (!value) return [];
  const markers = [...value.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  if (!markers.length) {
    const path = value.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1]
      || value.match(/^--- (?:a\/)?(.+)$/m)?.[1]
      || 'Changes';
    return [{ file: path, patch: value, ...diffCounts(value) }];
  }
  return markers.map((marker, index) => {
    const start = marker.index || 0;
    const end = markers[index + 1]?.index ?? value.length;
    const patch = value.slice(start, end).trimEnd();
    return { file: marker[2], patch, ...diffCounts(patch) };
  });
}

interface TranslatedCodexTool {
  tool: string;
  input: JsonObject;
  metadata?: JsonObject;
  processId?: number;
  continuation?: boolean;
}

function translateCodexTool(name: string, value: unknown): TranslatedCodexTool {
  const direct = input(value);
  if (name !== 'exec' || typeof value !== 'string') {
    const tool = canonicalToolName(name);
    if (tool === 'shell') {
      const command = direct.command !== undefined
        ? commandTitle(direct.command)
        : direct.cmd !== undefined
          ? commandTitle(direct.cmd)
          : string(direct.raw);
      return { tool, input: { ...direct, ...(command ? { command } : {}) } };
    }
    return { tool, input: direct };
  }

  const nested = sourceToolName(value);
  if (nested === 'exec_command') {
    const command = objectString(value, 'cmd');
    const cwd = objectString(value, 'workdir');
    return { tool: 'shell', input: { ...(command ? { command } : {}), ...(cwd ? { cwd } : {}) } };
  }
  if (nested === 'write_stdin') {
    const processId = objectNumber(value, 'session_id');
    const chars = objectString(value, 'chars');
    return {
      tool: 'shell',
      input: chars ? { command: chars } : {},
      processId,
      continuation: true,
    };
  }
  if (nested === 'apply_patch') {
    const patch = applyPatchSource(value);
    return { tool: 'patch', input: {}, metadata: { files: applyPatchFiles(patch) } };
  }
  if (nested === 'update_plan') return { tool: 'todowrite', input: {} };
  if (nested === 'web__run') {
    return { tool: 'websearch', input: { query: objectString(value, 'q') || 'Web search' } };
  }
  return { tool: canonicalToolName(nested || name), input: direct };
}

function sourceToolName(source: string): string | undefined {
  return source.match(/await\s+tools\.([A-Za-z0-9_]+)\s*\(/)?.[1]
    || source.match(/tools\.([A-Za-z0-9_]+)\s*\(/)?.[1];
}

interface CodexToolResult {
  output?: string;
  error?: string;
  exitCode?: number;
  processId?: number;
  running: boolean;
}

function codexToolResult(value: unknown): CodexToolResult {
  const texts = Array.isArray(value)
    ? value.flatMap(entryValue => {
      const entry = object(entryValue);
      return string(entry?.text) ? [string(entry?.text)!] : [];
    })
    : [textContent(value)];
  const joined = texts.filter(Boolean).join('');
  for (const text of texts) {
    try {
      const result = object(JSON.parse(text));
      if (!result) continue;
      const exitCode = typeof result.exit_code === 'number' ? result.exit_code : undefined;
      const processId = typeof result.session_id === 'number' ? result.session_id : undefined;
      const output = string(result.output);
      const failed = exitCode !== undefined && exitCode !== 0;
      return {
        output,
        error: failed ? `Exited with code ${exitCode}` : undefined,
        exitCode,
        processId,
        running: processId !== undefined && exitCode === undefined,
      };
    } catch { /* Not the structured result envelope. */ }
  }
  const failed = /(?:Script failed|Script error:)/.test(joined);
  const output = joined
    .replace(/^Script (?:completed|failed)\nWall time: [^\n]+\nOutput:\n/, '')
    .trim();
  return {
    output: output && output !== '{}' ? output : undefined,
    error: failed ? output || 'Tool failed' : undefined,
    running: false,
  };
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

interface PendingCodexTool extends TranslatedCodexTool {
  targetId: string;
}

/** Codex rollout knowledge. React consumes only the OpenCode-shaped transcript. */
export class CodexRolloutAdapter {
  private readonly messages: TranscriptMessage[] = [];
  private readonly messageIndexes = new Map<string, number>();
  private readonly tools = new Map<string, ToolLocation>();
  private readonly pendingCodexTools = new Map<string, PendingCodexTool>();
  private readonly processTools = new Map<number, string>();
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
        metadata: metadata || existing?.state.metadata
          ? { ...(existing?.state.metadata || {}), ...(metadata || {}) }
          : undefined,
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
      this.tool(id, 'shell', finiteStatus(item.exit_code), { command }, string(item.aggregated_output), undefined, { exitCode: item.exit_code }, at);
      return;
    }
    if (type === 'function_call') {
      const translated = translateCodexTool(string(item.name) || 'tool', item.arguments);
      this.tool(id, translated.tool, status(item.status, 'completed'), translated.input, string(item.output), undefined, translated.metadata, at);
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
      const translated = translateCodexTool('shell', action || {});
      this.tool(callId, translated.tool, status(payload.status, 'running'), translated.input, undefined, undefined, undefined, at);
      return;
    }
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      const name = string(payload.name) || string(payload.execution) || 'tool';
      const raw = payload.arguments ?? payload.input;
      const translated = translateCodexTool(name, raw);
      const continuedId = translated.continuation && translated.processId !== undefined
        ? this.processTools.get(translated.processId)
        : undefined;
      const targetId = continuedId || callId;
      const location = this.tools.get(`tool:${targetId}`);
      const message = location ? this.getMessage(location.messageId) : undefined;
      const current = message?.parts.find((item): item is TranscriptToolPart => item.id === `tool:${targetId}` && item.type === 'tool');
      this.pendingCodexTools.set(callId, { ...translated, targetId });
      this.tool(
        targetId,
        translated.tool,
        'running',
        continuedId ? current?.state.input : translated.input,
        current?.state.output,
        undefined,
        translated.metadata,
        at,
      );
      return;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const pending = this.pendingCodexTools.get(callId);
      const targetId = pending?.targetId || callId;
      const location = this.tools.get(`tool:${targetId}`);
      const message = location ? this.getMessage(location.messageId) : undefined;
      const current = message?.parts.find((item): item is TranscriptToolPart => item.id === `tool:${targetId}` && item.type === 'tool');
      if (pending) {
        const result = codexToolResult(payload.output);
        if (result.processId !== undefined) this.processTools.set(result.processId, targetId);
        const output = pending.continuation && result.output
          ? [current?.state.output, result.output].filter(Boolean).join('')
          : result.output;
        this.tool(
          targetId,
          pending.tool,
          result.error ? 'error' : result.running ? 'running' : 'completed',
          current?.state.input || pending.input,
          output,
          result.error,
          {
            ...(pending.metadata || {}),
            ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          },
          at,
        );
        this.pendingCodexTools.delete(callId);
        return;
      }
      this.tool(targetId, canonicalToolName(current?.tool || string(payload.name) || 'tool'), 'completed', current?.state.input, textContent(payload.output), undefined, current?.state.metadata, at);
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
      this.tool(callId, 'shell', 'running', {
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
      this.tool(callId, 'shell', status(payload.status, exitCode === 0 ? 'completed' : 'error'), {
        command: commandTitle(payload.command),
        ...(string(payload.cwd) ? { cwd: string(payload.cwd) } : {}),
      }, output, exitCode && exitCode !== 0 ? `Exited with code ${exitCode}` : undefined, { exitCode }, at);
      return;
    }
    if (type === 'patch_apply_begin' || type === 'patch_apply_updated') {
      this.tool(callId, 'patch', 'running', {}, undefined, undefined, { files: legacyChangeFiles(payload.changes) }, at);
      return;
    }
    if (type === 'patch_apply_end') {
      const output = [string(payload.stdout), string(payload.stderr)].filter(Boolean).join('\n');
      this.tool(callId, 'patch', payload.success === false ? 'error' : status(payload.status, 'completed'), {}, output, payload.success === false ? output || 'Patch failed' : undefined, { files: legacyChangeFiles(payload.changes) }, at);
      return;
    }
    if (type === 'turn_diff') {
      const files = unifiedDiffFiles(string(payload.unified_diff));
      if (files.length) {
        const message = this.assistantMessage(at);
        message.summary = { ...(message.summary || { diffs: [] }), diffs: files };
      }
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
