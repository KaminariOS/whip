import { CodexRolloutAdapter } from '../src/lib/codexRolloutAdapter';

const at = '2026-08-24T12:00:00.000Z';
const line = (type: string, payload: Record<string, unknown>) => ({ timestamp: at, type, payload });

describe('Codex rollout adapter', () => {
  test('normalizes current messages and removes overlapping event/response duplicates', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('session_meta', { id: 'thread', cwd: '/repo' }));
    adapter.accept(line('event_msg', { type: 'user_message', message: '你好 Codex' }));
    adapter.accept(line('response_item', { type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: '你好 Codex' }] }));
    adapter.accept(line('event_msg', { type: 'agent_message', message: 'Done.' }));
    adapter.accept(line('response_item', { type: 'message', id: 'a1', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }));
    expect(adapter.snapshot().filter(item => item.type === 'user-message')).toHaveLength(1);
    expect(adapter.snapshot().filter(item => item.type === 'assistant-message')).toHaveLength(1);
  });

  test('shows only explicit reasoning summaries, never raw chain-of-thought content', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('response_item', { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'Checked the failure.' }], content: [{ type: 'reasoning_text', text: 'hidden chain' }] }));
    adapter.accept(line('event_msg', { type: 'agent_reasoning_raw_content', text: 'also hidden' }));
    expect(adapter.snapshot()).toEqual([expect.objectContaining({ type: 'reasoning-summary', text: 'Checked the failure.' })]);
  });

  test('pairs command start, output, and completion', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('event_msg', { type: 'exec_command_begin', call_id: 'c1', command: ['rg', 'TODO'], cwd: '/repo' }));
    adapter.accept(line('event_msg', { type: 'exec_command_output_delta', call_id: 'c1', chunk: 'Zm9vCg==' }));
    adapter.accept(line('event_msg', { type: 'exec_command_end', call_id: 'c1', command: ['rg', 'TODO'], cwd: '/repo', aggregated_output: 'foo\n', exit_code: 0, status: 'completed' }));
    expect(adapter.snapshot()).toEqual([expect.objectContaining({ type: 'tool', toolKind: 'command', status: 'done', title: 'rg TODO', output: 'foo\n' })]);
  });

  test('normalizes file diffs, plans, generic tools, and ignores unknown future events', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('event_msg', { type: 'patch_apply_begin', call_id: 'p1', changes: { 'src/a.ts': { diff: '@@ -1 +1 @@' } } }));
    adapter.accept(line('event_msg', { type: 'patch_apply_end', call_id: 'p1', success: true, status: 'completed', changes: { 'src/a.ts': { diff: '@@ -1 +1 @@' } } }));
    adapter.accept(line('event_msg', { type: 'plan_update', explanation: 'Implement safely', plan: [{ step: 'Add tests', status: 'completed' }] }));
    adapter.accept(line('response_item', { type: 'function_call', call_id: 'f1', name: 'future_tool', arguments: '{"x":1}' }));
    adapter.accept(line('event_msg', { type: 'future_unknown_event', arbitrary: true }));
    expect(adapter.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', toolKind: 'file', status: 'done' }),
      expect.objectContaining({ type: 'plan', text: expect.stringContaining('Add tests') }),
      expect.objectContaining({ type: 'tool', toolKind: 'other', title: 'future_tool' }),
    ]));
  });
});
