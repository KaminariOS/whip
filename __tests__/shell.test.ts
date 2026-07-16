import { parseJsonResponse, shellQuote } from '../src/lib/shell';

describe('shell helpers', () => {
  test('quotes apostrophes without allowing shell interpolation', () => {
    expect(shellQuote("don't $expand")).toBe("'don'\"'\"'t $expand'");
  });

  test('extracts a Herdr result from SSH output', () => {
    const output = 'login banner\r\n{"id":"cli","result":{"type":"agent_list","agents":[{"pane_id":"w1:p1"}]}}\r\n';
    expect(parseJsonResponse(output, 'agents')).toEqual([{ pane_id: 'w1:p1' }]);
  });

  test('surfaces Herdr errors', () => {
    expect(() => parseJsonResponse('{"error":{"code":"not_found","message":"pane not found"}}')).toThrow(
      'pane not found',
    );
  });
});
