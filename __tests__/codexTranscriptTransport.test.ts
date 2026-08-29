import { createHostRuntime } from 'react-native-whip-ssh';

import { HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => (
  require('./mockWhipSsh').createMockWhipSshModule()
));

const mockWhipSsh = require('./mockWhipSsh').getMockWhipSshControl();
const connectWithPassword: jest.Mock = mockWhipSsh.connectWithPassword;

const sessionId = '11111111-1111-4111-8111-111111111111';
const profile: ConnectionProfile = {
  id: 'host', name: 'Host', host: 'host.test', port: '22', username: 'me', authMode: 'password',
  secret: 'secret', passphrase: '', herdrCommand: 'herdr', sessionName: 'main',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

describe('HerdrClient native transcript boundary', () => {
  test('delegates semantic transcript operations to HostRuntime', async () => {
    const native = {
      requestHerdrApi: jest.fn(async (_socket: string, request: { method: string }) => (
        request.method === 'ping'
          ? { type: 'pong', protocol: 20, version: 'test' }
          : { type: 'session_snapshot', snapshot: { protocol: 20, workspaces: [], tabs: [], panes: [] } }
      )),
      getRemoteHome: jest.fn(async () => '/home/me'),
      off: jest.fn(), disconnect: jest.fn(),
    };
    connectWithPassword.mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    const runtime = jest.mocked(createHostRuntime).mock.results[0].value;
    const transcript = {
      sessionId, agent: 'codex', revision: 1, status: 'loading', messages: [], turns: [],
    } as const;
    runtime.openAgentSession = jest.fn(() => ({ key: `codex:${sessionId}`, state: transcript }));
    runtime.bindAgentSession = jest.fn(() => ({ key: `codex:${sessionId}`, state: transcript }));
    runtime.startAgentSession = jest.fn(() => transcript);
    runtime.agentTranscript = jest.fn(() => transcript);
    runtime.closeAgentSession = jest.fn();
    runtime.closeAgentTerminal = jest.fn(() => `codex:${sessionId}`);
    runtime.confirmAgentTranscriptCache = jest.fn(() => true);
    const handler = jest.fn();
    const blob = new Uint8Array([1, 2]).buffer;

    expect(client.native.openAgentSession('codex', 'terminal-1', sessionId, blob, handler)).toEqual({
      key: `codex:${sessionId}`, state: transcript,
    });
    expect(runtime.openAgentSession).toHaveBeenCalledWith('codex', 'terminal-1', sessionId, blob, handler);
    expect(client.native.openAgentSession('opencode', 'terminal-2', 'ses_abc123', blob, handler)).toEqual({
      key: `codex:${sessionId}`, state: transcript,
    });
    expect(runtime.openAgentSession).toHaveBeenCalledWith('opencode', 'terminal-2', 'ses_abc123', blob, handler);
    expect(client.native.bindAgentSession('codex', 'terminal-1', sessionId, handler)).toEqual({
      key: `codex:${sessionId}`, state: transcript,
    });
    expect(runtime.bindAgentSession).toHaveBeenCalledWith('codex', 'terminal-1', sessionId, handler);
    expect(client.native.startAgentSession('terminal-1', `codex:${sessionId}`, blob)).toBe(transcript);
    expect(runtime.startAgentSession).toHaveBeenCalledWith('terminal-1', `codex:${sessionId}`, blob);
    expect(client.native.agentTranscript(`codex:${sessionId}`)).toBe(transcript);
    expect(client.native.closeAgentTerminal('terminal-1')).toBe(`codex:${sessionId}`);
    client.native.closeAgentSession(`codex:${sessionId}`);
    expect(client.native.confirmAgentTranscriptCache('token')).toBe(true);
    expect(runtime.closeAgentTerminal).toHaveBeenCalledWith('terminal-1');
    expect(runtime.closeAgentSession).toHaveBeenCalledWith(`codex:${sessionId}`);
  });
});
