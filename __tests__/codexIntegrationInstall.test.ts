import SSHClient from 'react-native-whip-ssh';

import { codexChatAction, codexMissingIdentityAction, parseCodexIntegrationStatus } from '../src/lib/codexSession';
import { CODEX_INTEGRATION_INSTALL_TIMEOUT_MS, HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile, PaneInfo } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({
  __esModule: true,
  default: { connectWithPassword: jest.fn(), connectWithKey: jest.fn() },
}));

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

  test('remote install only occurs when explicitly invoked and runs the integration command', async () => {
    const native = { execute: jest.fn(async () => ''), off: jest.fn(), disconnect: jest.fn() } as unknown as SSHClient;
    jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    expect(native.execute).not.toHaveBeenCalled(); // Cancel/no confirmation makes no remote change.
    await client.installCodexIntegration();
    expect(native.execute).toHaveBeenCalledTimes(1);
    expect(jest.mocked(native.execute).mock.calls[0][0]).toContain('integration install codex');
  });

  test('times out a stalled install once without retrying it', async () => {
    jest.useFakeTimers();
    try {
      const native = {
        execute: jest.fn(() => new Promise<string>(() => undefined)),
        off: jest.fn(),
        disconnect: jest.fn(),
      } as unknown as SSHClient;
      jest.mocked(SSHClient.connectWithPassword).mockResolvedValueOnce(native);
      const client = new HerdrClient();
      await client.connect(profile);

      let installError: unknown;
      const install = client.installCodexIntegration().catch(error => {
        installError = error;
      });
      await jest.advanceTimersByTimeAsync(CODEX_INTEGRATION_INSTALL_TIMEOUT_MS);
      await install;
      expect(installError).toEqual(expect.objectContaining({
        message: expect.stringContaining('timed out after 30 seconds'),
      }));
      expect(native.execute).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
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
