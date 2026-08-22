import { NativeModules, Platform } from 'react-native';

type PerformanceTraceNativeModule = {
  beginAsyncSection: (name: string, cookie: number) => boolean;
  endAsyncSection: (name: string, cookie: number) => boolean;
};

const performanceTrace = NativeModules.WhipPerformanceTrace as
  | PerformanceTraceNativeModule
  | undefined;
let nextCookie = 1;

const INPUT_TO_WRITE = 'Whip terminal input to native dispatch';
const INPUT_TO_FRAME = 'Whip terminal input to first frame';
const INPUT_TO_VISIBLE = 'Whip terminal input to visible';
const FRAME_TO_VISIBLE = 'Whip terminal frame to visible';
const PRE_NATIVE_WAIT = 'Whip terminal app pre-native wait';
const NATIVE_ENQUEUE = 'Whip terminal native enqueue';
const NATIVE_QUEUE_TO_RESPONSE = 'Whip terminal native queue to response';
const NATIVE_RESPONSE_TO_RENDERER = 'Whip terminal native response to renderer';
const TRACE_TIMEOUT_MS = 10_000;

export type TerminalInputTrace = {
  targetKey: string;
  writeCookie: number;
  frameCookie: number;
  visibleCookie: number;
  frameToVisibleCookie: number | null;
  preNativeWaitCookie: number | null;
  nativeEnqueueCookie: number | null;
  nativeQueueToResponseCookie: number | null;
  nativeResponseToRendererCookie: number | null;
  writeEnded: boolean;
  frameReceived: boolean;
  nativeResponseReceived: boolean;
  visibleEnded: boolean;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingByTarget = new Map<string, TerminalInputTrace[]>();
const pendingByVisibleCookie = new Map<number, TerminalInputTrace>();

function nextTraceCookie(): number {
  const cookie = nextCookie;
  nextCookie = nextCookie >= 0x7fffffff ? 1 : nextCookie + 1;
  return cookie;
}

function beginAsyncEvent(name: string, cookie = nextTraceCookie()): number {
  performanceTrace?.beginAsyncSection(name, cookie);
  return cookie;
}

function endAsyncEvent(name: string, cookie: number): void {
  performanceTrace?.endAsyncSection(name, cookie);
}

function endWrite(trace: TerminalInputTrace, _result: 'ok' | 'error' | 'timeout'): void {
  if (trace.writeEnded) return;
  trace.writeEnded = true;
  endAsyncEvent(INPUT_TO_WRITE, trace.writeCookie);
}

function endNativePhases(trace: TerminalInputTrace): void {
  if (trace.preNativeWaitCookie !== null) {
    endAsyncEvent(PRE_NATIVE_WAIT, trace.preNativeWaitCookie);
    trace.preNativeWaitCookie = null;
  }
  if (trace.nativeEnqueueCookie !== null) {
    endAsyncEvent(NATIVE_ENQUEUE, trace.nativeEnqueueCookie);
    trace.nativeEnqueueCookie = null;
  }
  if (trace.nativeQueueToResponseCookie !== null) {
    endAsyncEvent(NATIVE_QUEUE_TO_RESPONSE, trace.nativeQueueToResponseCookie);
    trace.nativeQueueToResponseCookie = null;
  }
  if (trace.nativeResponseToRendererCookie !== null) {
    endAsyncEvent(NATIVE_RESPONSE_TO_RENDERER, trace.nativeResponseToRendererCookie);
    trace.nativeResponseToRendererCookie = null;
  }
}

function removeFromTargetQueue(trace: TerminalInputTrace): void {
  const queue = pendingByTarget.get(trace.targetKey);
  if (!queue) return;
  const next = queue.filter(item => item !== trace);
  if (next.length) pendingByTarget.set(trace.targetKey, next);
  else pendingByTarget.delete(trace.targetKey);
}

function endVisible(trace: TerminalInputTrace, _result: 'visible' | 'error' | 'timeout'): void {
  if (trace.visibleEnded) return;
  trace.visibleEnded = true;
  endAsyncEvent(INPUT_TO_VISIBLE, trace.visibleCookie);
  if (trace.frameToVisibleCookie !== null) {
    endAsyncEvent(FRAME_TO_VISIBLE, trace.frameToVisibleCookie);
  }
  pendingByVisibleCookie.delete(trace.visibleCookie);
  clearTimeout(trace.timeout);
}

function abandonTrace(trace: TerminalInputTrace, result: 'error' | 'timeout'): void {
  endWrite(trace, result);
  endNativePhases(trace);
  if (!trace.frameReceived) {
    trace.frameReceived = true;
    endAsyncEvent(INPUT_TO_FRAME, trace.frameCookie);
  }
  removeFromTargetQueue(trace);
  endVisible(trace, result);
}

/** Starts a trace only while Perfetto has React Native tracing enabled. */
export function beginTerminalInputTrace(
  targetKey: string,
  _kind: 'input' | 'submit',
): TerminalInputTrace | null {
  if (Platform.OS !== 'android' || !performanceTrace) return null;

  const writeCookie = nextTraceCookie();
  if (!performanceTrace.beginAsyncSection(INPUT_TO_WRITE, writeCookie)) return null;
  const trace = {
    targetKey,
    writeCookie,
    frameCookie: beginAsyncEvent(INPUT_TO_FRAME),
    visibleCookie: beginAsyncEvent(INPUT_TO_VISIBLE),
    frameToVisibleCookie: null,
    preNativeWaitCookie: null,
    nativeEnqueueCookie: null,
    nativeQueueToResponseCookie: null,
    nativeResponseToRendererCookie: null,
    writeEnded: false,
    frameReceived: false,
    nativeResponseReceived: false,
    visibleEnded: false,
    timeout: undefined as unknown as ReturnType<typeof setTimeout>,
  } satisfies TerminalInputTrace;
  trace.timeout = setTimeout(() => abandonTrace(trace, 'timeout'), TRACE_TIMEOUT_MS);
  const queue = pendingByTarget.get(targetKey) || [];
  queue.push(trace);
  pendingByTarget.set(targetKey, queue);
  return trace;
}

export function endTerminalWriteTrace(trace: TerminalInputTrace | null, success: boolean): void {
  if (!trace) return;
  if (success) endWrite(trace, 'ok');
  else abandonTrace(trace, 'error');
}

/** Covers app-owned bridge readiness and scheduling before entering native code. */
export function terminalNativePreflightStarted(trace: TerminalInputTrace | null): void {
  if (!trace || trace.visibleEnded || trace.preNativeWaitCookie !== null) return;
  trace.preNativeWaitCookie = beginAsyncEvent(PRE_NATIVE_WAIT);
}

/** Starts immediately before Whip calls the react-native-russh UniFFI fast path. */
export function terminalNativeWriteStarted(trace: TerminalInputTrace | null): void {
  if (!trace || trace.visibleEnded || trace.nativeEnqueueCookie !== null) return;
  if (trace.preNativeWaitCookie !== null) {
    endAsyncEvent(PRE_NATIVE_WAIT, trace.preNativeWaitCookie);
    trace.preNativeWaitCookie = null;
  }
  trace.nativeEnqueueCookie = beginAsyncEvent(NATIVE_ENQUEUE);
}

/** Ends after Rust validates, frames, and queues the write for russh. */
export function terminalNativeWriteQueued(
  trace: TerminalInputTrace | null,
  success: boolean,
): void {
  if (!trace) return;
  if (trace.nativeEnqueueCookie !== null) {
    endAsyncEvent(NATIVE_ENQUEUE, trace.nativeEnqueueCookie);
    trace.nativeEnqueueCookie = null;
  }
  if (
    success
    && !trace.visibleEnded
    && !trace.nativeResponseReceived
    && trace.nativeQueueToResponseCookie === null
  ) {
    trace.nativeQueueToResponseCookie = beginAsyncEvent(NATIVE_QUEUE_TO_RESPONSE);
  }
}

/** Claims the first returned terminal frame for this input. */
export function terminalNativeResponseReceived(trace: TerminalInputTrace): boolean {
  if (trace.visibleEnded || trace.nativeResponseReceived) return false;
  trace.nativeResponseReceived = true;
  if (trace.nativeEnqueueCookie !== null) {
    endAsyncEvent(NATIVE_ENQUEUE, trace.nativeEnqueueCookie);
    trace.nativeEnqueueCookie = null;
  }
  if (trace.nativeQueueToResponseCookie !== null) {
    endAsyncEvent(NATIVE_QUEUE_TO_RESPONSE, trace.nativeQueueToResponseCookie);
    trace.nativeQueueToResponseCookie = null;
  }
  trace.nativeResponseToRendererCookie = beginAsyncEvent(NATIVE_RESPONSE_TO_RENDERER);
  return true;
}

/** Ends after HerdrClient synchronously hands the frame to the WebView renderer. */
export function terminalNativeResponseDelivered(trace: TerminalInputTrace | null): void {
  if (!trace || trace.nativeResponseToRendererCookie === null) return;
  endAsyncEvent(NATIVE_RESPONSE_TO_RENDERER, trace.nativeResponseToRendererCookie);
  trace.nativeResponseToRendererCookie = null;
}

/** Returns the cookie that the WebView must acknowledge after xterm paints. */
export function terminalFrameReceived(targetKey: string): number | null {
  const queue = pendingByTarget.get(targetKey);
  const trace = queue?.shift();
  if (!trace) return null;
  if (!queue?.length) pendingByTarget.delete(targetKey);
  trace.frameReceived = true;
  endAsyncEvent(INPUT_TO_FRAME, trace.frameCookie);
  trace.frameToVisibleCookie = beginAsyncEvent(FRAME_TO_VISIBLE);
  pendingByVisibleCookie.set(trace.visibleCookie, trace);
  return trace.visibleCookie;
}

export function terminalFrameRendered(visibleCookie: number): void {
  const trace = pendingByVisibleCookie.get(visibleCookie);
  if (trace) endVisible(trace, 'visible');
}
