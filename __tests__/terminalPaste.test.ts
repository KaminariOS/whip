import { prepareTerminalPaste } from '../src/lib/terminalPaste';

describe('terminal paste preparation', () => {
  test('normalizes line endings like xterm', () => {
    expect(prepareTerminalPaste('one\ntwo\r\nthree\rfour')).toBe('one\rtwo\rthree\rfour');
  });

  test('renders escape bytes instead of allowing pasted control sequences', () => {
    expect(prepareTerminalPaste('before\u001b[201~after')).toBe('before\u241b[201~after');
  });
});
