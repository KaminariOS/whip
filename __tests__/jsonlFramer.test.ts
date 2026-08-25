import { JsonlFramer } from '../src/lib/jsonlFramer';

const encoder = new TextEncoder();

describe('incremental JSONL framing', () => {
  test('handles multiple records in one SSH chunk', () => {
    const records: unknown[] = [];
    const consumed: number[] = [];
    const framer = new JsonlFramer({ onRecord: (record, metadata) => { records.push(record); consumed.push(metadata.consumedBytes); } });
    framer.push(encoder.encode('{"a":1}\n{"b":2}\n'));
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(consumed).toEqual([8, 8]);
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

  test('counts original UTF-8 bytes rather than JavaScript string length', () => {
    const source = '{"message":"你好"}\n';
    const metadata: Array<{ rawLine: string; consumedBytes: number }> = [];
    const framer = new JsonlFramer({ onRecord: (_record, value) => metadata.push(value) });
    framer.push(encoder.encode(source));
    expect(metadata).toEqual([{ rawLine: '{"message":"你好"}', consumedBytes: encoder.encode(source).byteLength }]);
  });

  test('includes CRLF bytes while excluding CR from rawLine', () => {
    const metadata: Array<{ rawLine: string; consumedBytes: number }> = [];
    const framer = new JsonlFramer({ onRecord: (_record, value) => metadata.push(value) });
    framer.push(encoder.encode('{"a":1}\r\n'));
    expect(metadata).toEqual([{ rawLine: '{"a":1}', consumedBytes: 9 }]);
  });

  test('keeps an incomplete trailing line unparsed', () => {
    const records: unknown[] = [];
    const framer = new JsonlFramer({ onRecord: record => records.push(record) });
    framer.push(encoder.encode('{"partial":true'));
    framer.end();
    expect(records).toEqual([]);
  });

  test('reconnect can replay an incomplete record from the committed cursor', () => {
    const first: unknown[] = [];
    const interrupted = new JsonlFramer({ onRecord: record => first.push(record) });
    interrupted.push(encoder.encode('{"partial":"你'));
    interrupted.end();
    expect(first).toEqual([]);

    const replayed: unknown[] = [];
    const resumed = new JsonlFramer({ onRecord: record => replayed.push(record) });
    resumed.push(encoder.encode('{"partial":"你好"}\n'));
    expect(replayed).toEqual([{ partial: '你好' }]);
  });

  test('skips malformed and unknown JSON records without terminating', () => {
    const records: unknown[] = [];
    const malformed: Array<[string, number]> = [];
    const framer = new JsonlFramer({
      onRecord: record => records.push(record),
      onMalformed: (line, _error, metadata) => malformed.push([line, metadata.consumedBytes]),
    });
    framer.push(encoder.encode('not-json\n{"type":"future_record","payload":{}}\n'));
    expect(malformed).toEqual([['not-json', 9]]);
    expect(records).toEqual([{ type: 'future_record', payload: {} }]);
  });
});
