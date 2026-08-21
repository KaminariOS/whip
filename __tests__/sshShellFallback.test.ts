import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import SSHClient, { PtyType } from 'react-native-whip-ssh';

import { HerdrClient } from '../src/services/HerdrClient';
import { SSH_SHELL_TERMINAL_ID } from '../src/terminalSessions';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({
  __esModule: true,
  default: {
    connectWithPassword: jest.fn(),
    connectWithKey: jest.fn(),
  },
  PtyType: {
    XTERM: 'xterm',
  },
}));

const connectWithPassword = jest.mocked(SSHClient.connectWithPassword);

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Fresh host',
  host: 'fresh.example.test',
  port: '22',
  username: 'operator',
  authMode: 'password',
  secret: 'secret',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function sshClient() {
  let shellHandler: ((data: string) => void) | undefined;
  return {
    client: {
      on: jest.fn((event: string, handler: (data: string) => void) => {
        if (event === 'Shell') shellHandler = handler;
      }),
      off: jest.fn(),
      startShell: jest.fn(async () => ''),
      writeToShell: jest.fn(async () => ''),
      resizeShell: jest.fn(),
      closeShell: jest.fn(),
      closeAllHerdrBridges: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as SSHClient,
    emitShell: (data: string) => shellHandler?.(data),
  };
}

describe('plain SSH shell fallback', () => {
  beforeEach(() => connectWithPassword.mockReset());

  it('does not cover an active SSH terminal with Herdr empty states', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain(
      '{!activeTarget && snapshot.server.running && !selectedTab && (',
    );
    expect(screen).toContain(
      '{!activeTarget && snapshot.server.running && selectedTab && panes.length === 0 && (',
    );
  });

  it('opens a dedicated interactive PTY and streams decoded text frames', async () => {
    const control = sshClient();
    const shell = sshClient();
    connectWithPassword
      .mockResolvedValueOnce(control.client)
      .mockResolvedValueOnce(shell.client);
    const client = new HerdrClient();
    const onFrame = jest.fn();

    await client.connect(profile);
    await client.openTerminal(SSH_SHELL_TERMINAL_ID, onFrame);
    shell.emitShell('\u001b[32moperator@fresh\u001b[0m $ ');

    expect(connectWithPassword).toHaveBeenCalledTimes(2);
    expect(shell.client.startShell).toHaveBeenCalledWith(PtyType.XTERM);
    expect(shell.client.resizeShell).toHaveBeenCalledWith(80, 24);
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.frame',
      seq: 1,
      encoding: 'utf8',
      full: false,
      bytes: '\u001b[32moperator@fresh\u001b[0m $ ',
    }));

    await client.writeToTerminal(SSH_SHELL_TERMINAL_ID, 'herdr --version\r');
    client.resizeTerminal(SSH_SHELL_TERMINAL_ID, 120, 40);

    expect(shell.client.writeToShell).toHaveBeenCalledWith('herdr --version\r');
    expect(shell.client.resizeShell).toHaveBeenLastCalledWith(120, 40);
  });

  it('closes only the fallback PTY when its terminal session closes', async () => {
    const control = sshClient();
    const shell = sshClient();
    connectWithPassword
      .mockResolvedValueOnce(control.client)
      .mockResolvedValueOnce(shell.client);
    const client = new HerdrClient();

    await client.connect(profile);
    await client.openTerminal(SSH_SHELL_TERMINAL_ID, jest.fn());
    await client.closeTerminalBridge(SSH_SHELL_TERMINAL_ID);

    expect(shell.client.closeShell).toHaveBeenCalledTimes(1);
    expect(shell.client.disconnect).toHaveBeenCalledTimes(1);
    expect(control.client.disconnect).not.toHaveBeenCalled();
    expect(client.isTerminalBridgeRetained(SSH_SHELL_TERMINAL_ID)).toBe(false);
  });
});
