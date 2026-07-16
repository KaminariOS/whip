import { parseAnsi } from './ansi';

export type AgentActivityKind = 'prompt' | 'question' | 'tool' | 'message';

export interface AgentActivityItem {
  id: string;
  kind: AgentActivityKind;
  text: string;
}

const BORDER_ONLY = /^[\s│┃┆┊╭╮╰╯┌┐└┘├┤┬┴┼─━═]+$/;
const TOOL_LINE = /^(?:[•●◉✓✔✗✕]\s*)?(?:read|write|edit|patch|search|grep|glob|bash|shell|run|running|executed|called|tool|fetch|build|test|lint)\b/i;

/** Converts the agent's terminal-oriented recent screen into a native activity feed. */
export function agentActivity(value: string, limit = 48): AgentActivityItem[] {
  const plain = parseAnsi(value).map(segment => segment.text).join('');
  const lines = plain
    .split('\n')
    .map(line => line.replace(/^[\s│┃┆┊]+|[\s│┃┆┊]+$/g, '').trim())
    .filter(line => line && !BORDER_ONLY.test(line));

  const items: AgentActivityItem[] = [];
  for (const text of lines) {
    if (items[items.length - 1]?.text === text) continue;
    const kind: AgentActivityKind = /^[>›❯]\s*/.test(text)
      ? 'prompt'
      : /\?$|approval|permission|choose|select|continue\b/i.test(text)
        ? 'question'
        : TOOL_LINE.test(text)
          ? 'tool'
          : 'message';
    items.push({ id: `${items.length}:${text}`, kind, text: text.replace(/^[>›❯]\s*/, '') });
  }
  return items.slice(-limit);
}
