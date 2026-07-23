import {
  classifyConnectionError,
  connectionErrorTranslationKeys,
} from '../src/lib/connectionErrors';

describe('connection error presentation', () => {
  test.each([
    ['java.net.UnknownHostException: thinker', 'unreachable'],
    ['connect failed: ENETUNREACH (Network is unreachable)', 'unreachable'],
    ['java.net.SocketTimeoutException: connect timed out', 'timeout'],
    ['java.net.ConnectException: Connection refused', 'connectionRefused'],
    ['com.jcraft.jsch.JSchException: Auth fail', 'authentication'],
    ['com.jcraft.jsch.JSchException: invalid privatekey', 'invalidKey'],
    ['HostKey has been changed', 'hostKey'],
    ['Herdr protocol mismatch: Whip supports 17, server reports 16', 'incompatibleProtocol'],
    ['Herdr API socket is not available', 'herdrUnavailable'],
    ['unexpected native failure', 'unknown'],
  ] as const)('maps %s to a friendly %s message', (error, kind) => {
    expect(classifyConnectionError(error)).toBe(kind);
  });

  it('uses translation keys instead of exposing native exception text', () => {
    expect(connectionErrorTranslationKeys.unreachable).toBe('app.connectUnreachableError');
    expect(Object.values(connectionErrorTranslationKeys)).not.toContain(
      'java.net.UnknownHostException',
    );
  });
});
