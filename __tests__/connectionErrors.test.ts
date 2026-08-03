import {
  classifyConnectionError,
  connectionErrorContext,
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
    ['E_HOST_KEY_CHANGED:{"host":"thinker"}', 'hostKey'],
    ['Herdr protocol mismatch: Whip supports 17 and 18, server reports 16', 'incompatibleProtocol'],
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

  it('preserves expected and reported protocol versions for the user-facing error', () => {
    expect(connectionErrorContext(
      'Herdr protocol mismatch: Whip supports 17 and 18, server reports 16',
    )).toEqual({
      expectedProtocol: '17 and 18',
      receivedProtocol: '16',
    });
    expect(connectionErrorContext(
      new Error('Herdr protocol mismatch: Android bridge supports 17 and 18, server reports 19'),
    )).toEqual({
      expectedProtocol: '17 and 18',
      receivedProtocol: '19',
    });
  });
});
