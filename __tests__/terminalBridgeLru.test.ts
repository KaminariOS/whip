import { HerdrClient } from '../src/services/HerdrClient';
import {
  terminalNativeWriteQueued,
  terminalResizeDeduplicated,
  terminalResizeSuperseded,
  type TerminalInputTrace,
  type TerminalResizeTrace,
} from '../src/services/performanceTrace';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => (
  require('./mockWhipSsh').createMockWhipSshModule()
));

jest.mock('../src/services/performanceTrace', () => ({
  ...jest.requireActual('../src/services/performanceTrace'),
  terminalNativePreflightStarted: jest.fn(),
  terminalNativeWriteStarted: jest.fn(),
  terminalNativeWriteQueued: jest.fn(),
  terminalResizeDeduplicated: jest.fn(),
  terminalResizeSuperseded: jest.fn(),
}));

const mockWhipSsh = require('./mockWhipSsh').getMockWhipSshControl();
const connectWithPassword: jest.Mock = mockWhipSsh.connectWithPassword;
const nativeWriteQueued = jest.mocked(terminalNativeWriteQueued);
const resizeDeduplicated = jest.mocked(terminalResizeDeduplicated);
const resizeSuperseded = jest.mocked(terminalResizeSuperseded);

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Test host',
  host: 'host.example.test',
  port: '22',
  username: 'herdr',
  authMode: 'password',
  secret: 'secret',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: 'main',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bridgeClient(protocol = 17) {
  const requestHerdrApi = jest.fn(async () => ({
    type: 'pong', version: 'test', protocol,
  }));
  const native = {
    requestHerdrApi,
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    startHerdrBridge: jest.fn(async (
      _socketPath: string,
      _protocol: number,
      _terminalId: string,
      _takeover: boolean,
      _columns: number,
      _rows: number,
      _cellWidthPx: number,
      _cellHeightPx: number,
      _handler: (event: Record<string, unknown>) => void,
    ): Promise<void> => undefined),
    herdrBridgeInput: jest.fn(async (
      _terminalId: string,
      _text: string,
    ): Promise<void> => undefined),
    herdrBridgeResize: jest.fn(async (): Promise<void> => undefined),
    herdrBridgeScroll: jest.fn(async (): Promise<void> => undefined),
    closeHerdrBridge: jest.fn(),
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  };
  return native;
}

describe('terminal bridge channels', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
    nativeWriteQueued.mockReset();
    resizeDeduplicated.mockReset();
    resizeSuperseded.mockReset();
  });

  test('retains every opened bridge across SSH clients without a maximum', async () => {
    const saviorNative = bridgeClient();
    const oracleNative = bridgeClient();
    connectWithPassword
      .mockResolvedValueOnce(saviorNative)
      .mockResolvedValueOnce(oracleNative);
    const savior = new HerdrClient();
    const oracle = new HerdrClient();
    await savior.connect(profile);
    await oracle.connect({ ...profile, id: 'host-2', host: 'oracle.example.test' });

    for (let index = 1; index <= 8; index += 1) {
      await savior.openTerminal(`savior-${index}`, jest.fn());
      await oracle.openTerminal(`oracle-${index}`, jest.fn());
    }

    expect(saviorNative.closeHerdrBridge).not.toHaveBeenCalled();
    expect(oracleNative.closeHerdrBridge).not.toHaveBeenCalled();
    for (let index = 1; index <= 8; index += 1) {
      expect(savior.isTerminalBridgeRetained(`savior-${index}`)).toBe(true);
      expect(oracle.isTerminalBridgeRetained(`oracle-${index}`)).toBe(true);
    }
  });

  test('explicit release removes a retained bridge immediately', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    const attachmentId = await client.openTerminal('term-1', jest.fn());
    await client.releaseTerminal('term-1', attachmentId);

    expect(client.isTerminalBridgeRetained('term-1')).toBe(false);
    expect(native.closeHerdrBridge).toHaveBeenCalledWith('term-1');
  });

  test('detaching a WebView controller keeps its SSH bridge warm', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    const attachmentId = await client.openTerminal('term-1', jest.fn());
    await client.detachTerminal('term-1', attachmentId);

    expect(client.isTerminalBridgeRetained('term-1')).toBe(true);
    expect(native.closeHerdrBridge).not.toHaveBeenCalled();
  });

  test('dispatches input to a retained bridge without an async readiness yield', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn());

    const write = client.writeToTerminal('term-1', '\u001b[B');

    expect(native.herdrBridgeInput).toHaveBeenCalledWith('term-1', '\u001b[B');
    await write;
  });

  test('a stale detach cannot remove a replacement controller', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    const firstOnFrame = jest.fn();
    const replacementOnFrame = jest.fn();
    await client.connect(profile);

    const firstAttachmentId = await client.openTerminal('term-1', firstOnFrame);
    await client.openTerminal('term-1', replacementOnFrame);
    await client.detachTerminal('term-1', firstAttachmentId);

    const bridgeHandler = jest.mocked(native.startHerdrBridge).mock.calls[0][8];
    bridgeHandler({
      type: 'terminal',
      seq: 1,
      full: false,
      width: 80,
      height: 24,
      bytes: '',
    });

    expect(firstOnFrame).not.toHaveBeenCalled();
    expect(replacementOnFrame).toHaveBeenCalledTimes(1);
  });

  test('a stale release cannot close a replacement controller bridge', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    const firstAttachmentId = await client.openTerminal('term-1', jest.fn());
    const replacementAttachmentId = await client.openTerminal('term-1', jest.fn());
    await client.releaseTerminal('term-1', firstAttachmentId);

    expect(client.isTerminalBridgeRetained('term-1')).toBe(true);
    expect(native.closeHerdrBridge).not.toHaveBeenCalled();

    await client.releaseTerminal('term-1', replacementAttachmentId);
    expect(client.isTerminalBridgeRetained('term-1')).toBe(false);
    expect(native.closeHerdrBridge).toHaveBeenCalledWith('term-1');
  });

  test('keeps the native enqueue trace open until a deferred write resolves', async () => {
    let resolveWrite!: () => void;
    const deferredWrite = new Promise<void>(resolve => {
      resolveWrite = resolve;
    });
    const native = bridgeClient();
    jest.mocked(native.herdrBridgeInput).mockReturnValueOnce(deferredWrite);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    const inputTrace = {} as TerminalInputTrace;
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn());

    const write = client.writeToTerminal('term-1', 'status\r', inputTrace);

    expect(nativeWriteQueued).not.toHaveBeenCalled();
    resolveWrite();
    await write;
    expect(nativeWriteQueued).toHaveBeenCalledWith(inputTrace, true);
  });

  test('marks a resize arriving during cold attach as superseded without replacing the dispatched trace', async () => {
    let resolveBridge!: () => void;
    const bridgeOpening = new Promise<void>(resolve => {
      resolveBridge = resolve;
    });
    const native = bridgeClient();
    jest.mocked(native.startHerdrBridge).mockReturnValueOnce(bridgeOpening);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    const initialTrace = { targetKey: 'initial' } as TerminalResizeTrace;
    const laterTrace = { targetKey: 'later' } as TerminalResizeTrace;
    await client.connect(profile);

    await client.resizeTerminal('term-1', 100, 30, 8, 16, initialTrace);
    const opening = client.openTerminal('term-1', jest.fn());
    await Promise.resolve();
    await client.resizeTerminal('term-1', 101, 31, 8, 16, laterTrace);

    expect(resizeSuperseded).toHaveBeenCalledWith(laterTrace);
    expect(resizeSuperseded).not.toHaveBeenCalledWith(initialTrace);

    resolveBridge();
    await opening;
  });

  test('skips an exact duplicate size after a retained bridge already dispatched it', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    const duplicateTrace = { targetKey: 'duplicate' } as TerminalResizeTrace;
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn());
    jest.mocked(native.herdrBridgeResize).mockClear();

    await client.resizeTerminal('term-1', 100, 30, 8, 16);
    await client.resizeTerminal('term-1', 100, 30, 8, 16, duplicateTrace);

    expect(native.herdrBridgeResize).toHaveBeenCalledTimes(1);
    expect(resizeDeduplicated).toHaveBeenCalledWith(duplicateTrace);
  });

  test('force-dispatches an exact duplicate when reclaiming terminal ownership', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn());
    jest.mocked(native.herdrBridgeResize).mockClear();

    await client.resizeTerminal('term-1', 100, 30, 8, 16);
    await client.resizeTerminal('term-1', 100, 30, 8, 16, null, true);

    expect(native.herdrBridgeResize).toHaveBeenCalledTimes(2);
    expect(resizeDeduplicated).not.toHaveBeenCalled();
  });

  test('retries the same size after a native resize dispatch fails', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn());
    jest.mocked(native.herdrBridgeResize).mockClear();
    jest.mocked(native.herdrBridgeResize)
      .mockRejectedValueOnce(new Error('resize failed'));

    await expect(client.resizeTerminal('term-1', 100, 30, 8, 16))
      .rejects.toThrow('resize failed');
    await client.resizeTerminal('term-1', 100, 30, 8, 16);

    expect(native.herdrBridgeResize).toHaveBeenCalledTimes(2);
  });

  test('forwards the touched terminal cell with attached-pane scrolling', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn());

    await client.scrollTerminal('term-1', 'up', 3, 12, 7);

    expect(native.herdrBridgeScroll).toHaveBeenCalledWith(
      'term-1',
      'up',
      3,
      12,
      7,
    );
  });

  test('debounces host-state reconciliation after remote resize and scroll activity', async () => {
    jest.useFakeTimers();
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    try {
      await client.connect(profile);
      await client.openTerminal('term-1', jest.fn());
      jest.mocked(native.requestHerdrApi).mockClear();

      await client.resizeTerminal('term-1', 100, 30, 8, 16);
      await client.scrollTerminal('term-1', 'up', 3, 12, 7);

      jest.advanceTimersByTime(119);
      await Promise.resolve();
      expect(native.requestHerdrApi).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      expect(native.requestHerdrApi).toHaveBeenCalledTimes(1);
    } finally {
      await client.disconnect();
      jest.useRealTimers();
    }
  });

  test('forwards protocol 20 terminal bells into the terminal renderer', async () => {
    const native = bridgeClient(20);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    const onFrame = jest.fn();
    await client.connect(profile);
    await client.openTerminal('term-1', onFrame);

    const bridgeHandler = jest.mocked(native.startHerdrBridge).mock.calls[0][8];
    bridgeHandler({ type: 'terminal_bell', count: 3 });

    expect(onFrame).toHaveBeenCalledWith({
      type: 'terminal.frame',
      seq: 0,
      encoding: 'utf8',
      width: 0,
      height: 0,
      full: false,
      bytes: '\u0007\u0007\u0007',
    });
  });

  test('ignores Herdr UI mouse capture and forwards Kitty keyboard mode changes', async () => {
    const native = bridgeClient(20);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    const onControl = jest.fn();
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn(), undefined, onControl);

    const bridgeHandler = jest.mocked(native.startHerdrBridge).mock.calls[0][8];
    bridgeHandler({ type: 'mouse_capture', flag: true });
    bridgeHandler({ type: 'kitty_keyboard_report_all', flag: true });

    expect(onControl).toHaveBeenLastCalledWith({
      type: 'protocol-state',
      state: { kittyKeyboardReportAll: true },
    });
    expect(onControl).not.toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ mouseCapture: expect.anything() }),
    }));
  });

  test('replays attached-pane protocol state when a renderer reattaches', async () => {
    const native = bridgeClient(20);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    const attachmentId = await client.openTerminal('term-1', jest.fn(), undefined, jest.fn());

    const bridgeHandler = jest.mocked(native.startHerdrBridge).mock.calls[0][8];
    bridgeHandler({ type: 'mouse_capture', flag: true });
    bridgeHandler({ type: 'kitty_keyboard_report_all', flag: true });
    await client.detachTerminal('term-1', attachmentId);

    const onControl = jest.fn();
    await client.openTerminal('term-1', jest.fn(), undefined, onControl);

    expect(onControl).toHaveBeenCalledWith({
      type: 'protocol-state',
      state: { kittyKeyboardReportAll: true },
    });
    expect(native.startHerdrBridge).toHaveBeenCalledTimes(1);
  });

  test('forwards dedicated clipboard and title messages', async () => {
    const native = bridgeClient(20);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    const onControl = jest.fn();
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn(), undefined, onControl);

    const bridgeHandler = jest.mocked(native.startHerdrBridge).mock.calls[0][8];
    bridgeHandler({ type: 'clipboard', text: 'copied by opencode' });
    bridgeHandler({ type: 'title', text: 'OpenCode' });

    expect(onControl).toHaveBeenCalledWith({
      type: 'clipboard-write',
      text: 'copied by opencode',
    });
    expect(onControl).toHaveBeenCalledWith({ type: 'title', title: 'OpenCode' });
  });
});
