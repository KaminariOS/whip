import {
  closeAllHerdrTerminalBridges,
  closeHerdrTerminalBridge,
  herdrTerminalInput,
  herdrTerminalResize,
  herdrTerminalScroll,
  pairHost as pairHostRust,
  prepareHerdrTerminalBridge,
  setHerdrTerminalEventSink,
  startHerdrTerminalBridge,
  type HerdrBridgeError,
  type HerdrTerminalControlEvent,
  type HerdrTerminalEventSink,
} from './generated-entry';

type PairingResponse = {
  ok: boolean;
  value?: unknown;
  error?: string;
};

type BridgeEvent = Record<string, unknown> & { type: string; terminalId: string };
type BridgeHandler = (event: BridgeEvent) => void;
type WhipTerminalInboundTrace = {
  jsReceived: () => number | null;
  decodeComplete: (cookie: number | null) => void;
};

const bridgeHandlers = new Map<string, Map<string, BridgeHandler>>();

function terminalInboundTrace(): WhipTerminalInboundTrace | undefined {
  return (globalThis as typeof globalThis & {
    __whipTerminalInboundTrace?: WhipTerminalInboundTrace;
  }).__whipTerminalInboundTrace;
}

function bridgeHandler(clientKey: string, terminalId: string): BridgeHandler | undefined {
  return bridgeHandlers.get(clientKey)?.get(terminalId);
}

function setBridgeHandler(clientKey: string, terminalId: string, handler: BridgeHandler): void {
  let handlers = bridgeHandlers.get(clientKey);
  if (!handlers) {
    handlers = new Map();
    bridgeHandlers.set(clientKey, handlers);
  }
  handlers.set(terminalId, handler);
}

function removeBridgeHandler(clientKey: string, terminalId: string): void {
  const handlers = bridgeHandlers.get(clientKey);
  handlers?.delete(terminalId);
  if (handlers?.size === 0) bridgeHandlers.delete(clientKey);
}

function bridgeError(error: unknown): Error {
  const nativeError = error as Partial<HerdrBridgeError> & {
    tag?: string;
    inner?: readonly unknown[];
  };
  const message = typeof nativeError.inner?.[0] === 'string'
    ? nativeError.inner[0]
    : error instanceof Error
      ? error.message
      : String(error);
  const result = new Error(message);
  result.name = 'HerdrBridgeError';
  if (nativeError.tag) Object.assign(result, { code: nativeError.tag });
  return result;
}

function controlEvent(event: HerdrTerminalControlEvent): BridgeEvent {
  const result: BridgeEvent = {
    type: event.kind,
    terminalId: event.terminalId,
  };
  if (['closed', 'title', 'clipboard', 'notify'].includes(event.kind)) result.text = event.text;
  if (event.kind === 'notify') {
    result.body = event.body;
    result.kind = event.notificationKind;
  }
  if (
    event.kind === 'mouse_capture'
    || event.kind === 'kitty_keyboard_report_all'
    || event.kind === 'prefix_input_source'
  ) result.flag = event.flag;
  if (event.kind === 'terminal_bell') result.count = event.count;
  return result;
}

const herdrTerminalEventSink: HerdrTerminalEventSink = {
  terminalFrame(clientKey, terminalId, sequence, width, height, full, bytes): void {
    const handler = bridgeHandler(clientKey, terminalId);
    if (!handler) return;
    const inboundTraceCookie = terminalInboundTrace()?.jsReceived() ?? null;
    terminalInboundTrace()?.decodeComplete(inboundTraceCookie);
    handler({
      type: 'terminal',
      terminalId,
      seq: Number(sequence),
      width,
      height,
      full,
      bytes,
      final: true,
      inboundTraceCookie,
    });
  },
  graphicsFrame(clientKey, terminalId, bytes): void {
    bridgeHandler(clientKey, terminalId)?.({
      type: 'graphics',
      terminalId,
      bytes,
    });
  },
  control(event): void {
    const handler = bridgeHandler(event.clientKey, event.terminalId);
    handler?.(controlEvent(event));
    if (event.kind === 'closed') removeBridgeHandler(event.clientKey, event.terminalId);
  },
};

setHerdrTerminalEventSink(herdrTerminalEventSink);

const nativeClient = {
  async pairHost(code: string, publicKey: string, deviceName: string): Promise<unknown> {
    const response = JSON.parse(await pairHostRust(code, publicKey, deviceName)) as PairingResponse;
    if (!response.ok) throw new Error(response.error || 'WP4 pairing failed');
    return response.value;
  },

  async prepareHerdrBridge(
    clientKey: string,
    socketPath: string,
    protocol: number,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ): Promise<void> {
    try {
      await prepareHerdrTerminalBridge(
        clientKey,
        socketPath,
        protocol,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      );
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async startHerdrBridge(
    clientKey: string,
    socketPath: string,
    protocol: number,
    terminalId: string,
    takeover: boolean,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    terminalAttachLaunchMode: number,
    handler: BridgeHandler,
  ): Promise<void> {
    setBridgeHandler(clientKey, terminalId, handler);
    try {
      await startHerdrTerminalBridge(
        clientKey,
        socketPath,
        protocol,
        terminalId,
        takeover,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
        terminalAttachLaunchMode,
      );
    } catch (error) {
      removeBridgeHandler(clientKey, terminalId);
      throw bridgeError(error);
    }
  },

  async herdrBridgeInput(clientKey: string, terminalId: string, text: string): Promise<void> {
    try {
      herdrTerminalInput(clientKey, terminalId, text);
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async herdrBridgeResize(
    clientKey: string,
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ): Promise<void> {
    try {
      herdrTerminalResize(
        clientKey,
        terminalId,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      );
    } catch (error) {
      throw bridgeError(error);
    }
  },

  async herdrBridgeScroll(
    clientKey: string,
    terminalId: string,
    up: boolean,
    lines: number,
    column: number | undefined,
    row: number | undefined,
    modifiers: number,
  ): Promise<void> {
    try {
      herdrTerminalScroll(clientKey, terminalId, up, lines, column, row, modifiers);
    } catch (error) {
      throw bridgeError(error);
    }
  },

  closeHerdrBridge(clientKey: string, terminalId: string): void {
    removeBridgeHandler(clientKey, terminalId);
    closeHerdrTerminalBridge(clientKey, terminalId);
  },

  closeAllHerdrBridges(clientKey: string): void {
    bridgeHandlers.delete(clientKey);
    closeAllHerdrTerminalBridges(clientKey);
  },
};

export default nativeClient;
