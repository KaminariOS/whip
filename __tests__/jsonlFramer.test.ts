import { JsonlFramer } from '../src/lib/jsonlFramer';

const encoder = new TextEncoder();

describe('incremental JSONL framing', () => {
  test('handles multiple records in one SSH chunk', () => {
    const records: unknown[] = [];
    const framer = new JsonlFramer({ onRecord: record => records.push(record) });
    framer.push(encoder.encode('{"a":1}\n{"b":2}\n'));
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('handles one record across chunks', () => {
    const records: unknown[] = [];
    const framer = new JsonlFramer({ onRecord: record => records.push(record) });
    framer.push(encoder.encode('{"message":"hel'));
    framer.push(encoder.encode('lo"}\n'));
    expect(records).toEqual([{ message: 'hello' }]);
  });

  test('preserves Chinese content split inside a UTF-8 character', () => {
    const bytes = encoder.encode('{"message":"你好，世界"}\n');
    const records: unknown[] = [];
    const framer = new JsonlFramer({ onRecord: record => records.push(record) });
    const split = bytes.indexOf(0xe5) + 1;
    framer.push(bytes.slice(0, split));
    framer.push(bytes.slice(split));
    expect(records).toEqual([{ message: '你好，世界' }]);
  });

  test('keeps an incomplete trailing line unparsed', () => {
    const records: unknown[] = [];
    const framer = new JsonlFramer({ onRecord: record => records.push(record) });
    framer.push(encoder.encode('{"partial":true'));
    framer.end();
    expect(records).toEqual([]);
  });

  test('skips malformed and unknown JSON records without terminating', () => {
    const records: unknown[] = [];
    const malformed: string[] = [];
    const framer = new JsonlFramer({ onRecord: record => records.push(record), onMalformed: line => malformed.push(line) });
    framer.push(encoder.encode('not-json\n{"type":"future_record","payload":{}}\n'));
    expect(malformed).toEqual(['not-json']);
    expect(records).toEqual([{ type: 'future_record', payload: {} }]);
  });
});
