import {
  applyOpenCodeEvents,
  openCodeEventCursorCommand,
  openCodeEventsCommand,
  openCodeExportCommand,
  parseOpenCodeEventCursor,
  parseOpenCodeTranscript,
} from '../src/lib/openCodeTranscript';

const exported = {
  info: {
    id: 'ses_abc123',
    title: 'Fix chat view',
    directory: '/repo',
    time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    summary: { additions: 4, deletions: 2, files: 1 },
  },
  messages: [
    {
      info: { id: 'msg_user', role: 'user', time: { created: 1_700_000_000_000 } },
      parts: [
        { id: 'prt_context', type: 'text', text: 'hidden context', synthetic: true },
        { id: 'prt_prompt', type: 'text', text: 'Fix it' },
        { id: 'prt_file', type: 'file', mime: 'image/png', filename: 'broken.png', url: 'file:///tmp/broken.png' },
      ],
    },
    {
      info: {
        id: 'msg_assistant', role: 'assistant', parentID: 'msg_user', agent: 'build',
        providerID: 'anthropic', modelID: 'claude-sonnet', time: { created: 1_700_000_000_100 },
      },
      parts: [
        { id: 'prt_reasoning', type: 'reasoning', text: 'Inspecting the layout.' },
        {
          id: 'prt_tool', type: 'tool', callID: 'call_1', tool: 'bash',
          state: {
            status: 'completed', title: 'Run tests', input: { command: 'npm test' }, output: 'ok',
            time: { start: 1_700_000_000_200, end: 1_700_000_000_300 },
          },
        },
        { id: 'prt_text', type: 'text', text: 'Done.' },
        {
          id: 'prt_finish', type: 'step-finish', reason: 'stop', cost: 0.012,
          tokens: { total: 120, input: 80, output: 40, cache: { read: 10, write: 2 } },
        },
      ],
    },
  ],
};

test('projects the official OpenCode export without flattening its typed parts', () => {
  const transcript = parseOpenCodeTranscript(exported);
  expect(transcript.sessionId).toBe('ses_abc123');
  expect(transcript.info).toEqual(expect.objectContaining({ title: 'Fix chat view', directory: '/repo' }));
  expect(transcript.messages).toHaveLength(2);
  expect(transcript.messages[0].parts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'prt_context', type: 'text', synthetic: true }),
    expect.objectContaining({ id: 'prt_file', type: 'file', filename: 'broken.png' }),
  ]));
  expect(transcript.messages[1]).toEqual(expect.objectContaining({
    parentId: 'msg_user', agent: 'build', providerId: 'anthropic', modelId: 'claude-sonnet',
  }));
  expect(transcript.messages[1].parts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'reasoning', text: 'Inspecting the layout.' }),
    expect.objectContaining({
      type: 'tool', tool: 'bash', callId: 'call_1',
      state: expect.objectContaining({ status: 'completed', output: 'ok' }),
    }),
  ]));
  expect(transcript.turns).toEqual([
    expect.objectContaining({
      id: 'msg_user', status: 'idle', cost: 0.012,
      tokens: expect.objectContaining({ total: 120, cacheRead: 10, cacheWrite: 2 }),
    }),
  ]);
});

test('uses the official read-only export command and rejects unsafe IDs', () => {
  expect(openCodeExportCommand('ses_abc123')).toBe("opencode export 'ses_abc123'");
  expect(openCodeEventCursorCommand('ses_abc123')).toContain('MAX(seq)');
  expect(openCodeEventsCommand('ses_abc123', 42)).toContain('seq > 42');
  expect(parseOpenCodeEventCursor([{ seq: 42 }])).toBe(42);
  expect(() => openCodeExportCommand("ses_x'; DROP TABLE part;--")).toThrow('Invalid OpenCode session ID');
  expect(() => openCodeEventsCommand('ses_abc123', -1)).toThrow('Invalid OpenCode event cursor');
});

test('applies official durable OpenCode events incrementally, including removals', () => {
  const before = parseOpenCodeTranscript(exported);
  const result = applyOpenCodeEvents(before, [
    {
      seq: 8,
      type: 'message.part.updated',
      data: JSON.stringify({
        sessionID: 'ses_abc123', time: 1_700_000_000_400,
        part: {
          id: 'prt_tool', sessionID: 'ses_abc123', messageID: 'msg_assistant', type: 'tool', callID: 'call_1', tool: 'bash',
          state: { status: 'error', input: { command: 'npm test' }, error: 'failed' },
        },
      }),
    },
    {
      seq: 9,
      type: 'message.part.removed',
      data: { sessionID: 'ses_abc123', messageID: 'msg_assistant', partID: 'prt_reasoning' },
    },
  ], 7);

  expect(result.cursor).toBe(9);
  expect(result.transcript.messages[0]).toBe(before.messages[0]);
  expect(result.transcript.messages[1].parts).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'prt_reasoning' }),
  ]));
  expect(result.transcript.messages[1].parts).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: 'prt_tool', type: 'tool',
      state: expect.objectContaining({ status: 'error', error: 'failed' }),
    }),
  ]));
  expect(result.transcript.turns[0].status).toBe('error');
});

test('rejects values that are not official OpenCode exports', () => {
  expect(() => parseOpenCodeTranscript([])).toThrow('invalid session export');
  expect(() => parseOpenCodeTranscript({ info: { id: 'ses_abc123' } })).toThrow('invalid session export');
});
