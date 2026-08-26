jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => ({
  closeAllHerdrTerminalBridges: jest.fn(),
  closeHerdrTerminalBridge: jest.fn(),
  herdrTerminalInput: jest.fn(),
  herdrTerminalResize: jest.fn(),
  herdrTerminalScroll: jest.fn(),
  pairHost: jest.fn(),
  prepareHerdrTerminalBridge: jest.fn().mockResolvedValue(undefined),
  setHerdrTerminalEventSink: jest.fn(),
  startHerdrTerminalBridge: jest.fn().mockResolvedValue(undefined),
}));

import nativeClient from '../packages/react-native-whip-ssh/src';

const mockGenerated = jest.requireMock(
  '../packages/react-native-whip-ssh/src/generated-entry',
);
const mockEventSink = mockGenerated.setHerdrTerminalEventSink.mock.calls[0][0];

describe('native Herdr bridge adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards native binary frames without string, base64, or JSON conversion', async () => {
    const handler = jest.fn();
    await nativeClient.startHerdrBridge(
      'client-1',
      '/tmp/herdr.sock',
      20,
      'terminal-1',
      true,
      80,
      24,
      8,
      16,
      1,
      handler,
    );

    const payload = Uint8Array.from([0, 0xff, 0x80, 0x1b]).buffer;
    mockEventSink.terminalFrame('client-1', 'terminal-1', 42n, 80, 24, true, payload);

    expect(handler).toHaveBeenCalledWith({
      type: 'terminal',
      terminalId: 'terminal-1',
      seq: 42,
      width: 80,
      height: 24,
      full: true,
      bytes: payload,
      final: true,
      inboundTraceCookie: null,
    });
    expect(handler.mock.calls[0][0].bytes).toBe(payload);
  });

  it('maps typed native control records to the existing public event shape', async () => {
    const handler = jest.fn();
    await nativeClient.startHerdrBridge(
      'client-1',
      '/tmp/herdr.sock',
      17,
      'terminal-1',
      false,
      80,
      24,
      0,
      0,
      1,
      handler,
    );

    mockEventSink.control({
      clientKey: 'client-1',
      terminalId: 'terminal-1',
      kind: 'notify',
      text: 'done',
      body: 'body',
      notificationKind: 2,
    });

    expect(handler).toHaveBeenCalledWith({
      type: 'notify',
      terminalId: 'terminal-1',
      text: 'done',
      body: 'body',
      kind: 2,
    });
  });
});
