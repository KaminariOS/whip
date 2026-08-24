import SSHClient from 'react-native-whip-ssh';

import { HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({
  __esModule: true,
  default: {
    connectWithPassword: jest.fn(),
    connectWithKey: jest.fn(),
  },
}));

const connectWithPassword = jest.mocked(SSHClient.connectWithPassword);

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
  const requestHerdrApi = jest.fn(async (_socketPath: string, requestLine: string) => {
    const request = JSON.parse(requestLine);
    return JSON.stringify({
      id: request.id,
      result: { type: 'pong', version: 'test', protocol },
    });
  });
  const native = {
    requestHerdrApi,
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    startHerdrBridge: jest.fn(async () => undefined),
    herdrBridgeInput: jest.fn(async () => undefined),
    herdrBridgeResize: jest.fn(async () => undefined),
    herdrBridgeScroll: jest.fn(async () => undefined),
    closeHerdrBridge: jest.fn(),
    closeAllHerdrBridges: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as SSHClient;
  return native;
}

describe('terminal bridge channels', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
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

    await client.openTerminal('term-1', jest.fn());
    await client.releaseTerminal('term-1');

    expect(client.isTerminalBridgeRetained('term-1')).toBe(false);
    expect(native.closeHerdrBridge).toHaveBeenCalledWith('term-1');
  });

  test('detaching a WebView controller keeps its SSH bridge warm', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await client.openTerminal('term-1', jest.fn());
    await client.detachTerminal('term-1');

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

  test('encodes a stationary terminal tap as an SGR mouse click', async () => {
    const native = bridgeClient();
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await client.openTerminal('term-1', jest.fn());

    await client.clickTerminal('term-1', 12, 7);

    expect(native.herdrBridgeInput).toHaveBeenCalledWith(
      'term-1',
      '\u001b[<0;13;8M\u001b[<0;13;8m',
    );
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

  test('uses the published protocol 20 terminal attach mode without changing the bridge handler position', async () => {
    const native = bridgeClient(20);
    connectWithPassword.mockResolvedValue(native);
    const client = new HerdrClient();
    await client.connect(profile);

    await client.openTerminal('term-1', jest.fn());

    const call = jest.mocked(native.startHerdrBridge).mock.calls[0];
    expect(typeof call[8]).toBe('function');
    expect(call[9]).toBe(2);
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
    await client.openTerminal('term-1', jest.fn(), undefined, jest.fn());

    const bridgeHandler = jest.mocked(native.startHerdrBridge).mock.calls[0][8];
    bridgeHandler({ type: 'mouse_capture', flag: true });
    bridgeHandler({ type: 'kitty_keyboard_report_all', flag: true });
    await client.detachTerminal('term-1');

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
