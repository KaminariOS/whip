import SSHClient from 'react-native-whip-ssh';

import { codexChatAction, codexMissingIdentityAction, parseCodexIntegrationStatus } from '../src/lib/codexSession';
import { HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile, PaneInfo } from '../src/types';

jest.mock('react-native-whip-ssh', () => (
  require('./mockWhipSsh').createMockWhipSshModule()
));

const id = '11111111-1111-4111-8111-111111111111';
const profile: ConnectionProfile = {
  id: 'host', name: 'Host', host: 'host.test', port: '22', username: 'me', authMode: 'password',
  secret: 'secret', passphrase: '', herdrCommand: 'herdr', sessionName: 'main',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const pane = (agent: string, session?: string): PaneInfo => ({
  pane_id: 'p', terminal_id: 't', tab_id: 'tab', workspace_id: 'w', focused: true, revision: 1,
  agent, display_agent: agent, agent_status: 'idle',
  ...(session ? { agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: session } } : {}),
});

describe('Codex integration installation flow', () => {
  beforeEach(() => jest.mocked(SSHClient.connectWithPassword).mockReset());

  test('Codex with session opens, missing session asks setup, non-Codex is unavailable', () => {
    expect(codexChatAction(pane('codex', id))).toBe('open');
    expect(codexChatAction(pane('codex'))).toBe('setup');
    expect(codexChatAction(pane('shell'))).toBe('unavailable');
  });

  test('remote install only occurs when explicitly invoked and returns the socket API result', async () => {
    const response = {
      type: 'integration_install' as const,
      target: 'codex' as const,
      details: { messages: ['Installed Codex integration'] },
    };
    const native = {
      execute: jest.fn(async () => ''),
      requestHerdrApi: jest.fn(async (_socketPath: string, request: { method: string }) => (
        request.method === 'integration.install' ? response : { type: 'ok' }
      )),
      off: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as SSHClient;
    jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    expect(native.execute).not.toHaveBeenCalled(); // Cancel/no confirmation makes no remote change.
    await expect(client.installCodexIntegration()).resolves.toEqual(response);
    expect(native.requestHerdrApi).toHaveBeenCalledTimes(1);
    expect(native.requestHerdrApi).toHaveBeenCalledWith(
      '/home/me/.config/herdr/sessions/main/herdr.sock',
      { method: 'integration.install', params: { target: 'codex' } },
    );
    expect(native.execute).not.toHaveBeenCalled();
  });

  test('forwards a socket install failure without retrying it', async () => {
    const native = {
      execute: jest.fn(async () => ''),
      requestHerdrApi: jest.fn(async (_socketPath: string, request: { method: string }) => {
        if (request.method === 'integration.install') throw new Error('installation failed');
        return { type: 'ok' };
      }),
      off: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as SSHClient;
    jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.installCodexIntegration()).rejects.toThrow('installation failed');
    expect(native.requestHerdrApi).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['codex: current (v2) (/home/me/.codex/config.toml)', 'current'],
    ['codex: outdated (v1 < v2) (/home/me/.codex/config.toml)', 'outdated'],
    ['codex: needs repair (v2) (/home/me/.codex/config.toml)', 'needs-repair'],
    ['codex: not installed (/home/me/.codex/config.toml)', 'not-installed'],
  ] as const)('parses integration status %s', (output, expected) => {
    expect(parseCodexIntegrationStatus(output)).toBe(expected);
  });

  test('an installed integration is detected without running install', async () => {
    const native = {
      execute: jest.fn(async () => 'claude: not installed (/tmp/claude)\ncodex: current (v2) (/home/me/.codex/config.toml)\n'),
      off: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as SSHClient;
    jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await expect(client.codexIntegrationStatus()).resolves.toBe('current');
    expect(native.execute).toHaveBeenCalledTimes(1);
    expect(jest.mocked(native.execute).mock.calls[0][0]).toContain('integration status');
    expect(jest.mocked(native.execute).mock.calls[0][0]).not.toContain('integration install codex');
  });

  test('unknown status output is not mistaken for a missing installation', () => {
    expect(parseCodexIntegrationStatus('older herdr output')).toBe('unknown');
  });

  test('a current integration requests diagnosis instead of installation or another blind restart', () => {
    expect(codexMissingIdentityAction('current')).toBe('diagnose');
    expect(codexMissingIdentityAction('not-installed')).toBe('install');
    expect(codexMissingIdentityAction('outdated')).toBe('install');
    expect(codexMissingIdentityAction('needs-repair')).toBe('install');
    expect(codexMissingIdentityAction('unknown')).toBe('unknown');
  });
});
