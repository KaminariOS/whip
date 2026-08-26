import * as herdrApiBridge from '../src/lib/herdrApiBridge';
import * as herdrEvents from '../src/lib/herdrEvents';

describe('Herdr TypeScript boundary', () => {
  it('contains types only; native Rust owns the control and event wire protocols', () => {
    expect(Object.keys(herdrApiBridge)).toEqual([]);
    expect(Object.keys(herdrEvents)).toEqual([]);
  });
});
