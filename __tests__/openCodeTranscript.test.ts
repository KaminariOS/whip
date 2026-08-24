import { openCodeTranscriptQuery, parseOpenCodeTranscript } from '../src/lib/openCodeTranscript';

const row = (message: object, part: object) => ({
  message_id: 'msg_1', message_time: 1_700_000_000_000, message_data: JSON.stringify(message),
  part_id: `prt_${String((part as { type?: string }).type)}`, part_data: JSON.stringify(part),
});

test('OpenCode transcript hides synthetic user context and keeps visible turns and tools', () => {
  const items = parseOpenCodeTranscript([
    row({ role: 'user' }, { type: 'text', text: 'hidden context', synthetic: true }),
    row({ role: 'user' }, { type: 'text', text: 'Fix it' }),
    { ...row({ role: 'assistant' }, { type: 'text', text: 'Done' }), message_id: 'msg_2' },
    { ...row({ role: 'assistant' }, { type: 'tool', tool: 'bash', state: { status: 'completed', title: 'npm test', input: {}, output: 'ok' } }), message_id: 'msg_2' },
  ]);
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'user-message', text: 'Fix it' }),
    expect.objectContaining({ type: 'assistant-message', text: 'Done' }),
    expect.objectContaining({ type: 'tool', toolKind: 'command', status: 'done' }),
  ]));
  expect(items).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: 'hidden context' })]));
});

test('OpenCode query is bounded, removes binary attachments, and rejects unsafe IDs', () => {
  expect(openCodeTranscriptQuery('ses_abc123')).toContain('LIMIT 120');
  expect(openCodeTranscriptQuery('ses_abc123')).toContain("'$.state.attachments'");
  expect(() => openCodeTranscriptQuery("ses_x'; DROP TABLE part;--")).toThrow('Invalid OpenCode session ID');
});
