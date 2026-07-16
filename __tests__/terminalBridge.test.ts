import {
  TerminalBridgeDecoder,
  terminalInputCommand,
  terminalResizeCommand,
  terminalScrollCommand,
} from '../src/lib/terminalBridge';

describe('Herdr terminal bridge', () => {
  test('decodes chunked frames and ignores SSH shell noise', () => {
    const decoder = new TerminalBridgeDecoder();

    expect(decoder.push('Last login: today\r\nuser@host $ command\r\n{"type":"terminal.')).toEqual([]);
    expect(decoder.push('frame","seq":4,"encoding":"ansi","width":80,"height":24,"full":true,"bytes":"G1sySg=="}\r\n')).toEqual([
      {
        type: 'terminal.frame',
        seq: 4,
        encoding: 'ansi',
        width: 80,
        height: 24,
        full: true,
        bytes: 'G1sySg==',
      },
    ]);
  });

  test('encodes input and resize as newline-delimited commands', () => {
    expect(terminalInputCommand('\u001b[A')).toBe('{"type":"terminal.input","text":"\\u001b[A"}\n');
    expect(terminalResizeCommand(100, 31, 8, 16)).toBe('{"type":"terminal.resize","cols":100,"rows":31,"cell_width_px":8,"cell_height_px":16}\n');
    expect(terminalScrollCommand('up', 3)).toBe('{"type":"terminal.scroll","direction":"up","lines":3,"source":"wheel"}\n');
  });
});
