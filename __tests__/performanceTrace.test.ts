const mockBeginAsyncSection = jest.fn<boolean, [string, number]>(() => true);
const mockEndAsyncSection = jest.fn<boolean, [string, number]>(() => true);

jest.mock('react-native', () => ({
  NativeModules: {
    WhipPerformanceTrace: {
      beginAsyncSection: (name: string, cookie: number) =>
        mockBeginAsyncSection(name, cookie),
      endAsyncSection: (name: string, cookie: number) =>
        mockEndAsyncSection(name, cookie),
    },
  },
  Platform: { OS: 'android' },
}));

import {
  beginTerminalInputTrace,
  endTerminalWriteTrace,
  withTerminalWriteTrace,
} from '../src/services/performanceTrace';

describe('terminal performance tracing', () => {
  beforeEach(() => {
    mockBeginAsyncSection.mockClear();
    mockEndAsyncSection.mockClear();
  });

  test('keeps the write trace open until a deferred operation resolves', async () => {
    let resolveOperation!: (value: string) => void;
    const deferredOperation = new Promise<string>(resolve => {
      resolveOperation = resolve;
    });
    const trace = beginTerminalInputTrace('terminal-1', 'input');
    const writeCookie = mockBeginAsyncSection.mock.calls[0][1];

    const result = withTerminalWriteTrace(trace, () => deferredOperation);

    expect(mockEndAsyncSection).not.toHaveBeenCalledWith(
      'Whip terminal input to native dispatch',
      writeCookie,
    );

    resolveOperation('written');
    await expect(result).resolves.toBe('written');

    expect(mockEndAsyncSection).toHaveBeenCalledWith(
      'Whip terminal input to native dispatch',
      writeCookie,
    );

    // Complete the remaining input-to-frame/visible slices and clear the timeout.
    endTerminalWriteTrace(trace, false);
  });
});
