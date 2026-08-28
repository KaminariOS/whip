import {
  composeTerminalSubmission,
  terminalSubmissionWrites,
} from '../src/lib/terminalSubmission';

describe('terminal composer submission', () => {
  test.each([
    ['text only', 'please inspect', [], ['please inspect'], 'please inspect'],
    ['image only', '', ['/remote/one.png'], ['/remote/one.png'], '/remote/one.png'],
    [
      'text then one image',
      'please inspect   ',
      ['/remote/one.png'],
      ['please inspect', '/remote/one.png'],
      'please inspect /remote/one.png',
    ],
    [
      'text then multiple images',
      'compare',
      ['/remote/one.png', '/remote/two.png'],
      ['compare', '/remote/one.png', '/remote/two.png'],
      'compare /remote/one.png /remote/two.png',
    ],
    [
      'multiple attachments without text',
      '',
      ['/remote/one.png', '/remote/report final.pdf'],
      ['/remote/one.png', '/remote/report final.pdf'],
      '/remote/one.png /remote/report final.pdf',
    ],
  ])('%s', (_label, text, paths, expectedEvents, expectedHistory) => {
    expect(composeTerminalSubmission(text, paths)).toEqual({
      historyEntry: expectedHistory,
      pasteEvents: expectedEvents,
    });
  });

  test('keeps each paste separate and writes whitespace and Enter in order', () => {
    expect(terminalSubmissionWrites([
      '\u001b[200~please inspect\u001b[201~',
      '\u001b[200~/remote/one.png\u001b[201~',
      '\u001b[200~/remote/two.png\u001b[201~',
    ])).toEqual([
      '\u001b[200~please inspect\u001b[201~',
      ' ',
      '\u001b[200~/remote/one.png\u001b[201~',
      ' ',
      '\u001b[200~/remote/two.png\u001b[201~',
      '\r',
    ]);
  });

  test('submits an empty composer as Enter only', () => {
    expect(composeTerminalSubmission('   ', [])).toEqual({ historyEntry: '', pasteEvents: [] });
    expect(terminalSubmissionWrites([])).toEqual(['\r']);
  });
});
