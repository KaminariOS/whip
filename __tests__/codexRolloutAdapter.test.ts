import type { AgentTranscript, TranscriptPart } from '../src/agentChat';
import { CodexRolloutAdapter } from '../src/lib/codexRolloutAdapter';

const at = '2026-08-24T12:00:00.000Z';
const line = (type: string, payload: Record<string, unknown>) => ({ timestamp: at, type, payload });
const parts = (transcript: AgentTranscript): TranscriptPart[] => transcript.messages.flatMap(message => message.parts);
const texts = (transcript: AgentTranscript, role: 'user' | 'assistant') => transcript.messages
  .filter(message => message.role === role)
  .flatMap(message => message.parts)
  .filter(part => part.type === 'text')
  .map(part => part.text);

describe('Codex rollout adapter', () => {
  test('normalizes into the OpenCode transcript model and removes event/response duplicates', () => {
    const adapter = new CodexRolloutAdapter('requested-thread');
    adapter.accept(line('session_meta', { id: 'thread', cwd: '/repo' }));
    adapter.accept(line('event_msg', { type: 'user_message', message: '你好 Codex' }));
    adapter.accept(line('response_item', { type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: '你好 Codex' }] }));
    adapter.accept(line('event_msg', { type: 'agent_message', message: 'Done.' }));
    adapter.accept(line('response_item', { type: 'message', id: 'a1', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }));
    const transcript = adapter.snapshot();
    expect(transcript.sessionId).toBe('thread');
    expect(transcript.info?.directory).toBe('/repo');
    expect(texts(transcript, 'user')).toEqual(['你好 Codex']);
    expect(texts(transcript, 'assistant')).toEqual(['Done.']);
    expect(transcript.turns).toHaveLength(1);
  });

  test('does not expose synthetic user-role context from response items', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('response_item', {
      type: 'message', id: 'context', role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nprivate context\n</INSTRUCTIONS>' }],
    }));
    adapter.accept(line('response_item', {
      type: 'message', id: 'u1', role: 'user',
      content: [{ type: 'input_text', text: 'Please fix the chat view' }],
    }));
    adapter.accept(line('event_msg', { type: 'user_message', message: 'Please fix the chat view' }));

    expect(texts(adapter.snapshot(), 'user')).toEqual(['Please fix the chat view']);
  });

  test('keeps a first user response item when no matching event exists', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('response_item', {
      type: 'message', id: 'u1', role: 'user',
      content: [{ type: 'input_text', text: 'Check gold and HYPE market structure' }],
    }));

    expect(texts(adapter.snapshot(), 'user')).toEqual(['Check gold and HYPE market structure']);
  });

  test('shows only explicit reasoning summaries, never raw chain-of-thought content', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('response_item', { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'Checked the failure.' }], content: [{ type: 'reasoning_text', text: 'hidden chain' }] }));
    adapter.accept(line('event_msg', { type: 'agent_reasoning_raw_content', text: 'also hidden' }));
    expect(parts(adapter.snapshot())).toEqual([
      expect.objectContaining({ type: 'reasoning', text: 'Checked the failure.' }),
    ]);
  });

  test('pairs command start, output, and completion', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('event_msg', { type: 'exec_command_begin', call_id: 'c1', command: ['rg', 'TODO'], cwd: '/repo' }));
    adapter.accept(line('event_msg', { type: 'exec_command_output_delta', call_id: 'c1', chunk: 'Zm9vCg==' }));
    adapter.accept(line('event_msg', { type: 'exec_command_end', call_id: 'c1', command: ['rg', 'TODO'], cwd: '/repo', aggregated_output: 'foo\n', exit_code: 0, status: 'completed' }));
    expect(parts(adapter.snapshot())).toEqual([
      expect.objectContaining({
        type: 'tool', tool: 'shell',
        state: expect.objectContaining({ status: 'completed', output: 'foo\n' }),
      }),
    ]);
  });

  test('uses call_id to merge a custom exec call and its output into one shell row', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('response_item', {
      type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: { cmd: 'git status' },
    }));
    adapter.accept(line('response_item', {
      type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_1', output: 'clean',
    }));

    expect(parts(adapter.snapshot())).toEqual([
      expect.objectContaining({
        id: 'tool:call_1', type: 'tool', tool: 'shell',
        state: expect.objectContaining({ status: 'completed', output: 'clean' }),
      }),
    ]);
  });

  test('normalizes file diffs, plans, generic tools, and ignores unknown future events', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('event_msg', { type: 'patch_apply_begin', call_id: 'p1', changes: { 'src/a.ts': { diff: '@@ -1 +1 @@' } } }));
    adapter.accept(line('event_msg', { type: 'patch_apply_end', call_id: 'p1', success: true, status: 'completed', changes: { 'src/a.ts': { diff: '@@ -1 +1 @@' } } }));
    adapter.accept(line('event_msg', { type: 'plan_update', explanation: 'Implement safely', plan: [{ step: 'Add tests', status: 'completed' }] }));
    adapter.accept(line('response_item', { type: 'function_call', call_id: 'f1', name: 'future_tool', arguments: '{"x":1}' }));
    adapter.accept(line('event_msg', { type: 'future_unknown_event', arbitrary: true }));
    expect(parts(adapter.snapshot())).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', tool: 'patch', state: expect.objectContaining({ status: 'completed' }) }),
      expect.objectContaining({ type: 'plan', text: expect.stringContaining('Add tests') }),
      expect.objectContaining({ type: 'tool', tool: 'future_tool' }),
    ]));
  });

  test('unwraps Codex exec orchestration into an OpenCode shell part', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('response_item', {
      type: 'custom_tool_call', call_id: 'shell_1', name: 'exec',
      input: 'const r = await tools.exec_command({cmd:"rg TODO src","workdir":"/repo"}); text(r);',
    }));
    adapter.accept(line('response_item', {
      type: 'custom_tool_call_output', call_id: 'shell_1',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time: 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'src/a.ts:1:TODO\n' }) },
      ],
    }));

    expect(parts(adapter.snapshot())).toEqual([
      expect.objectContaining({
        id: 'tool:shell_1', type: 'tool', tool: 'shell',
        state: expect.objectContaining({
          status: 'completed',
          input: { command: 'rg TODO src', cwd: '/repo' },
          output: 'src/a.ts:1:TODO\n',
          metadata: { exitCode: 0 },
        }),
      }),
    ]);
  });

  test('joins Codex write_stdin updates into the originating shell part', () => {
    const adapter = new CodexRolloutAdapter();
    adapter.accept(line('response_item', {
      type: 'custom_tool_call', call_id: 'shell_1', name: 'exec',
      input: 'const r = await tools.exec_command({cmd:"npm test"}); text(r);',
    }));
    adapter.accept(line('response_item', {
      type: 'custom_tool_call_output', call_id: 'shell_1',
      output: [{ type: 'input_text', text: JSON.stringify({ session_id: 42, output: 'starting\n' }) }],
    }));
    adapter.accept(line('response_item', {
      type: 'custom_tool_call', call_id: 'poll_1', name: 'exec',
      input: 'const r = await tools.write_stdin({session_id:42,chars:""}); text(r);',
    }));
    adapter.accept(line('response_item', {
      type: 'custom_tool_call_output', call_id: 'poll_1',
      output: [{ type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'passed\n' }) }],
    }));

    const toolParts = parts(adapter.snapshot()).filter(part => part.type === 'tool');
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]).toEqual(expect.objectContaining({
      id: 'tool:shell_1', type: 'tool', tool: 'shell',
      state: expect.objectContaining({ status: 'completed', output: 'starting\npassed\n' }),
    }));
  });

  test('converts Codex apply_patch source and turn diffs into OpenCode file metadata', () => {
    const adapter = new CodexRolloutAdapter();
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';
    adapter.accept(line('response_item', {
      type: 'custom_tool_call', call_id: 'patch_1', name: 'exec',
      input: `const patch = ${JSON.stringify(patch)}; const r = await tools.apply_patch(patch); text(r);`,
    }));
    adapter.accept(line('response_item', {
      type: 'custom_tool_call_output', call_id: 'patch_1',
      output: [{ type: 'input_text', text: '{}' }],
    }));
    adapter.accept(line('event_msg', {
      type: 'turn_diff',
      unified_diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
    }));

    expect(parts(adapter.snapshot())).toEqual([
      expect.objectContaining({
        type: 'tool', tool: 'patch',
        state: expect.objectContaining({
          metadata: {
            files: [expect.objectContaining({
              filePath: 'src/a.ts', type: 'update', patch: '@@\n-old\n+new', additions: 1, deletions: 1,
            })],
          },
        }),
      }),
    ]);
    expect(adapter.snapshot().turns[0].diffs).toEqual([
      expect.objectContaining({ file: 'src/a.ts', additions: 1, deletions: 1 }),
    ]);
  });
});
