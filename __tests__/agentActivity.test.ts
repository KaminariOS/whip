import { agentActivity } from '../src/lib/agentActivity';

test('turns ANSI TUI lines into classified native activity', () => {
  expect(agentActivity('\u001b[32m╭────╮\u001b[0m\n› Fix the tests\nRead package.json\nContinue?')).toEqual([
    { id: '0:› Fix the tests', kind: 'prompt', text: 'Fix the tests' },
    { id: '1:Read package.json', kind: 'tool', text: 'Read package.json' },
    { id: '2:Continue?', kind: 'question', text: 'Continue?' },
  ]);
});

test('deduplicates consecutive redraw lines and keeps the tail', () => {
  expect(agentActivity('same\nsame\nnew', 1)).toEqual([
    { id: '1:new', kind: 'message', text: 'new' },
  ]);
});
