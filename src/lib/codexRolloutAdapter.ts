import type { AgentChatItem, AgentToolKind, AgentToolStatus } from '../agentChat';

type JsonObject = Record<string, unknown>;

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
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function commandTitle(command: unknown): string {
  if (Array.isArray(command)) return command.filter(part => typeof part === 'string').join(' ');
  return string(command) || 'Command';
}

function toolKind(name: string): AgentToolKind {
  if (/apply[_-]?patch|file|edit|write/i.test(name)) return 'file';
  if (/exec|shell|command|terminal/i.test(name)) return 'command';
  if (/web|search|fetch|open_page/i.test(name)) return 'web';
  if (/mcp/i.test(name)) return 'mcp';
  return 'other';
}

function status(value: unknown, fallback: AgentToolStatus): AgentToolStatus {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (/fail|error|declin|incomplete/.test(normalized)) return 'failed';
  if (/complete|done|success/.test(normalized)) return 'done';
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

function formatChanges(changes: unknown): string | undefined {
  const value = object(changes);
  if (!value) return detail(changes);
  return Object.entries(value).map(([path, change]) => {
    const entry = object(change);
    const patch = string(entry?.diff) || string(entry?.patch) || detail(change) || '';
    return patch ? `### ${path}\n\n${patch}` : path;
  }).join('\n\n');
}

interface MessageSignature {
  id: string;
  sequence: number;
}

/** Codex-specific rollout knowledge. React consumes only AgentChatItem. */
export class CodexRolloutAdapter {
  private readonly items: AgentChatItem[] = [];
  private readonly indexes = new Map<string, number>();
  private readonly recentMessages = new Map<string, MessageSignature>();
  private sequence = 0;

  snapshot(): AgentChatItem[] {
    return this.items.map(item => ({ ...item }));
  }

  accept(recordValue: unknown): void {
    const record = object(recordValue);
    const payload = object(record?.payload);
    const recordType = string(record?.type);
    if (!record || !payload || !recordType) return;
    this.sequence += 1;
    const timestamp = string(record.timestamp);
    if (recordType === 'response_item') this.acceptResponse(payload, timestamp);
    if (recordType === 'event_msg') this.acceptEvent(payload, timestamp);
  }

  private put(item: AgentChatItem): void {
    const index = this.indexes.get(item.id);
    if (index === undefined) {
      this.indexes.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[index] = { ...this.items[index], ...item } as AgentChatItem;
    }
  }

  private message(role: 'user' | 'assistant', text: string, id: string, timestamp?: string): void {
    const normalized = text.trim();
    if (!normalized) return;
    const signature = `${role}\n${normalized}`;
    const recent = this.recentMessages.get(signature);
    if (recent && this.sequence - recent.sequence <= 4) {
      this.recentMessages.set(signature, { id: recent.id, sequence: this.sequence });
      return;
    }
    const itemId = `message:${id}`;
    this.recentMessages.set(signature, { id: itemId, sequence: this.sequence });
    this.put({
      id: itemId,
      type: role === 'user' ? 'user-message' : 'assistant-message',
      text: normalized,
      timestamp,
    });
  }

  private acceptResponse(payload: JsonObject, timestamp?: string): void {
    const type = string(payload.type) || '';
    const id = string(payload.id) || string(payload.call_id) || `${this.sequence}`;
    if (type === 'message') {
      const content = textContent(payload.content);
      if (payload.role === 'assistant') this.message('assistant', content, `response:${id}`, timestamp);
      // Some rollout versions do not emit an event_msg for the first user turn.
      // Keep genuine response-item turns, while rejecting the injected context
      // that Codex also records with a user role.
      if (payload.role === 'user' && !isInjectedUserContext(content)) {
        this.message('user', content, `response:${id}`, timestamp);
      }
      return;
    }
    if (type === 'reasoning') {
      const summary = textContent(payload.summary).trim();
      // Deliberately ignore `content` and encrypted/raw reasoning.
      if (summary) this.put({ id: `reasoning:${id}`, type: 'reasoning-summary', text: summary, timestamp });
      return;
    }
    if (type === 'local_shell_call') {
      const action = object(payload.action);
      const command = commandTitle(action?.command);
      this.tool(id, 'command', command, status(payload.status, 'running'), detail(action), undefined, undefined, timestamp);
      return;
    }
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      const name = string(payload.name) || string(payload.execution) || 'Tool';
      this.tool(id, toolKind(name), name, status(payload.status, 'running'), string(payload.arguments) || string(payload.input) || detail(payload.arguments), undefined, undefined, timestamp);
      return;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const callId = string(payload.call_id) || id;
      const index = this.indexes.get(`tool:${callId}`);
      const current = index === undefined ? undefined : this.items[index];
      this.tool(callId, current?.type === 'tool' ? current.toolKind : 'other', current?.type === 'tool' ? current.title : string(payload.name) || 'Tool', 'done', current?.type === 'tool' ? current.detail : undefined, textContent(payload.output), current?.type === 'tool' ? current.diff : undefined, timestamp);
      return;
    }
    if (type === 'web_search_call') {
      const action = object(payload.action);
      const title = string(action?.query) || (Array.isArray(action?.queries) ? action.queries.join(', ') : undefined) || 'Web search';
      this.tool(id, 'web', title, status(payload.status, 'running'), detail(action), undefined, undefined, timestamp);
    }
  }

  private acceptEvent(payload: JsonObject, timestamp?: string): void {
    const type = string(payload.type) || '';
    const callId = string(payload.call_id) || `${this.sequence}`;
    if (type === 'user_message') {
      this.message('user', string(payload.message) || '', `event:${callId}`, timestamp);
      return;
    }
    if (type === 'agent_message') {
      this.message('assistant', string(payload.message) || '', `event:${callId}`, timestamp);
      return;
    }
    if (type === 'agent_reasoning') {
      const text = string(payload.text);
      if (text) this.put({ id: `reasoning:event:${callId}`, type: 'reasoning-summary', text, timestamp });
      return;
    }
    if (type === 'exec_command_begin') {
      this.tool(callId, 'command', commandTitle(payload.command), 'running', string(payload.cwd), undefined, undefined, timestamp);
      return;
    }
    if (type === 'exec_command_output_delta') {
      // The current schema stores arbitrary bytes as independent base64 chunks.
      // Wait for exec_command_end's authoritative aggregated UTF-8 output rather
      // than corrupting a multibyte character split across delta records.
      return;
    }
    if (type === 'exec_command_end') {
      const output = string(payload.aggregated_output) || [string(payload.stdout), string(payload.stderr)].filter(Boolean).join('\n');
      this.tool(callId, 'command', commandTitle(payload.command), status(payload.status, Number(payload.exit_code) === 0 ? 'done' : 'failed'), string(payload.cwd), output, undefined, timestamp);
      return;
    }
    if (type === 'patch_apply_begin' || type === 'patch_apply_updated') {
      this.tool(callId, 'file', 'File changes', 'running', undefined, undefined, formatChanges(payload.changes), timestamp);
      return;
    }
    if (type === 'patch_apply_end') {
      this.tool(callId, 'file', 'File changes', payload.success === false ? 'failed' : status(payload.status, 'done'), undefined, [string(payload.stdout), string(payload.stderr)].filter(Boolean).join('\n'), formatChanges(payload.changes), timestamp);
      return;
    }
    if (type === 'turn_diff') {
      this.put({ id: `tool:diff:${this.sequence}`, type: 'tool', toolKind: 'file', title: 'Turn diff', status: 'done', diff: string(payload.unified_diff), timestamp });
      return;
    }
    if (type === 'mcp_tool_call_begin' || type === 'mcp_tool_call_end') {
      const invocation = object(payload.invocation);
      const title = [string(invocation?.server), string(invocation?.tool)].filter(Boolean).join(' · ') || 'MCP tool';
      this.tool(callId, 'mcp', title, type.endsWith('_end') ? (object(payload.result)?.Err ? 'failed' : 'done') : 'running', detail(invocation?.arguments), type.endsWith('_end') ? detail(payload.result) : undefined, undefined, timestamp);
      return;
    }
    if (type === 'web_search_begin' || type === 'web_search_end') {
      this.tool(callId, 'web', string(payload.query) || 'Web search', type.endsWith('_end') ? 'done' : 'running', detail(payload.action), undefined, undefined, timestamp);
      return;
    }
    if (type === 'plan_update') {
      const text = formatPlan(payload);
      if (text) this.put({ id: `plan:${this.sequence}`, type: 'plan', text, timestamp });
      return;
    }
    if (type === 'error' || type === 'warning' || type === 'stream_error' || type === 'deprecation_notice') {
      const text = string(payload.message) || string(payload.summary) || detail(payload) || type;
      this.put({ id: `notice:${this.sequence}`, type: 'notice', text, timestamp });
      return;
    }
    if (/approval_request|request_user_input|elicitation_request|request_permissions/.test(type)) {
      this.put({ id: `notice:${this.sequence}`, type: 'notice', text: 'Codex is waiting for an interactive response. Open Terminal to respond.', timestamp });
    }
  }

  private tool(id: string, kind: AgentToolKind, title: string, toolStatus: AgentToolStatus, toolDetail?: string, output?: string, diff?: string, timestamp?: string): void {
    const key = `tool:${id}`;
    const index = this.indexes.get(key);
    const current = index === undefined ? undefined : this.items[index];
    this.put({
      id: key,
      type: 'tool',
      toolKind: kind,
      title,
      status: toolStatus,
      detail: toolDetail ?? (current?.type === 'tool' ? current.detail : undefined),
      output: output ?? (current?.type === 'tool' ? current.output : undefined),
      diff: diff ?? (current?.type === 'tool' ? current.diff : undefined),
      timestamp: timestamp ?? current?.timestamp,
    });
  }
}
