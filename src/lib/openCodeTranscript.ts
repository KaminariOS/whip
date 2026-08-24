import type { AgentChatItem, AgentToolKind, AgentToolStatus } from '../agentChat';
import { shellQuote } from './shell';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function parsed(value: unknown): JsonObject | null {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return null; }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function detail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function toolKind(name: string): AgentToolKind {
  if (/patch|edit|write|file|read/i.test(name)) return 'file';
  if (/bash|shell|command|terminal/i.test(name)) return 'command';
  if (/web|search|fetch/i.test(name)) return 'web';
  if (/mcp/i.test(name)) return 'mcp';
  return 'other';
}

function toolStatus(value: unknown): AgentToolStatus {
  const status = typeof value === 'string' ? value.toLowerCase() : '';
  if (/error|fail/.test(status)) return 'failed';
  if (/complete|done/.test(status)) return 'done';
  return 'running';
}

export function openCodeTranscriptQuery(sessionId: string): string {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Invalid OpenCode session ID');
  const query = `WITH latest AS (`
    + `SELECT id FROM message WHERE session_id = '${sessionId}' ORDER BY time_created DESC, id DESC LIMIT 120`
    + `) SELECT m.id AS message_id, m.time_created AS message_time, m.data AS message_data, p.id AS part_id, `
    + `CASE WHEN json_extract(p.data, '$.type') = 'tool' THEN `
    + `json_remove(json_set(p.data, '$.state.output', substr(COALESCE(json_extract(p.data, '$.state.output'), ''), 1, 4000)), '$.state.metadata', '$.state.attachments') `
    + `ELSE p.data END AS part_data FROM message m LEFT JOIN part p ON p.message_id = m.id `
    + `WHERE m.id IN (SELECT id FROM latest) AND (p.id IS NULL OR json_extract(p.data, '$.type') IN ('text', 'tool')) `
    + `ORDER BY m.time_created, m.id, p.id`;
  return `opencode db ${shellQuote(query)} --format json --pure`;
}

export function parseOpenCodeTranscript(value: unknown): AgentChatItem[] {
  const rows = Array.isArray(value) ? value : [];
  const items: AgentChatItem[] = [];
  const visibleUsers = new Set<string>();
  for (const rowValue of rows) {
    const row = object(rowValue);
    const message = parsed(row?.message_data);
    const part = parsed(row?.part_data);
    const messageId = text(row?.message_id);
    const partId = text(row?.part_id);
    const role = message?.role;
    if (!messageId || !part || !partId) continue;
    const timestamp = typeof row?.message_time === 'number'
      ? new Date(row.message_time).toISOString()
      : undefined;
    if (part.type === 'text') {
      const content = text(part.text);
      if (!content) continue;
      if (role === 'user') {
        if (part.synthetic === true || part.ignored === true || visibleUsers.has(messageId)) continue;
        visibleUsers.add(messageId);
        items.push({ id: `message:${messageId}`, type: 'user-message', text: content, timestamp });
      } else if (role === 'assistant' && part.synthetic !== true && part.ignored !== true) {
        items.push({ id: `message:${partId}`, type: 'assistant-message', text: content, timestamp });
      }
      continue;
    }
    if (role !== 'assistant' || part.type !== 'tool') continue;
    const state = object(part.state);
    const name = text(part.tool) || 'Tool';
    items.push({
      id: `tool:${partId}`,
      type: 'tool',
      toolKind: toolKind(name),
      title: text(state?.title) || name,
      status: toolStatus(state?.status),
      detail: detail(state?.input),
      output: text(state?.output),
      timestamp,
    });
  }
  return items;
}
