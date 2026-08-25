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
  beginTerminalColdInputWait,
  beginTerminalInputTrace,
  beginTerminalRendererReadinessTrace,
  beginTerminalResizeTrace,
  endAppPerformanceTrace,
  endTerminalWriteTrace,
  terminalRendererBecameReady,
  terminalRendererEntryReached,
  terminalRendererSizeBecameReady,
  terminalResizeFrameReceived,
  terminalResizeFrameRendered,
  terminalResizeNativeDispatchEnded,
  terminalResizeNativeDispatchStarted,
  terminalResizeRequestHandled,
  terminalResizeRequestReady,
  terminalResizeWaitStarted,
  terminalTabSelectionStarted,
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

  test('ends cold input readiness immediately before the queued operation continues', () => {
    const trace = beginTerminalColdInputWait();
    const cookie = mockBeginAsyncSection.mock.calls.at(-1)?.[1];

    expect(mockBeginAsyncSection).toHaveBeenCalledWith(
      'Whip terminal cold input to writable',
      cookie,
    );
    endAppPerformanceTrace(trace);
    expect(mockEndAsyncSection).toHaveBeenCalledWith(
      'Whip terminal cold input to writable',
      cookie,
    );
  });

  test('renderer readiness waits for both xterm and initial size readiness', () => {
    const trace = beginTerminalRendererReadinessTrace();
    const readinessCookie = mockBeginAsyncSection.mock.calls.find(
      ([name]) => name === 'Whip terminal renderer readiness',
    )?.[1];

    terminalRendererBecameReady(trace);
    expect(mockEndAsyncSection).not.toHaveBeenCalledWith(
      'Whip terminal renderer readiness',
      readinessCookie,
    );

    terminalRendererSizeBecameReady(trace);
    expect(mockEndAsyncSection).toHaveBeenCalledWith(
      'Whip terminal renderer readiness',
      readinessCookie,
    );
    expect(mockEndAsyncSection).toHaveBeenCalledWith(
      'Whip terminal xterm creation',
      expect.any(Number),
    );
    expect(mockEndAsyncSection).toHaveBeenCalledWith(
      'Whip terminal initial size measurement',
      expect.any(Number),
    );
  });

  test('correlates user tab selection with the renderer entry reached after React state propagation', () => {
    terminalTabSelectionStarted('terminal-tab');
    const cookie = mockBeginAsyncSection.mock.calls.at(-1)?.[1];

    terminalRendererEntryReached('terminal-tab');

    expect(mockBeginAsyncSection).toHaveBeenCalledWith(
      'Whip terminal tab selection to renderer entry',
      cookie,
    );
    expect(mockEndAsyncSection).toHaveBeenCalledWith(
      'Whip terminal tab selection to renderer entry',
      cookie,
    );
  });

  test('correlates resize request, readiness wait, native dispatch, frame, and visibility', () => {
    const trace = beginTerminalResizeTrace('terminal-resize', 'fit', 100, 32, 8, 16, 1.25, 2.5);
    terminalResizeRequestReady(trace);
    terminalResizeWaitStarted(trace);
    terminalResizeNativeDispatchStarted(trace);
    terminalResizeNativeDispatchEnded(trace, true);
    terminalResizeRequestHandled(trace);

    const visibleCookie = terminalResizeFrameReceived('terminal-resize');
    expect(visibleCookie).not.toBeNull();
    terminalResizeFrameRendered(visibleCookie!);

    for (const name of [
      'Whip terminal resize request',
      'Whip terminal resize: fit',
      'Whip terminal resize wait for writable',
      'Whip terminal resize native dispatch',
      'Whip terminal resize to first frame',
      'Whip terminal resize frame to visible',
      'Whip terminal resize to visible',
    ]) {
      expect(mockBeginAsyncSection).toHaveBeenCalledWith(name, expect.any(Number));
      expect(mockEndAsyncSection).toHaveBeenCalledWith(name, expect.any(Number));
    }
    expect(mockBeginAsyncSection).toHaveBeenCalledWith(
      expect.stringMatching(/^Whip terminal resize event: #\d+ fit 100x32 cell=8x16 local-fit=1\.25ms webview-queue=2\.5ms$/),
      expect.any(Number),
    );
  });
});
