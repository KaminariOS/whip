import { shellQuote } from '../src/lib/shell';

describe('shell helpers', () => {
  test('quotes apostrophes without allowing shell interpolation', () => {
    expect(shellQuote("don't $expand")).toBe("'don'\"'\"'t $expand'");
  });
});
