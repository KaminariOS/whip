import {
  classifyConnectionError,
  connectionErrorContext,
  connectionErrorTranslationKeys,
  errorCode,
  privateKeyErrorTranslationKey,
} from '../src/lib/connectionErrors';

describe('connection error presentation', () => {
  test.each([
    ['java.net.UnknownHostException: thinker', 'unreachable'],
    ['connect failed: ENETUNREACH (Network is unreachable)', 'unreachable'],
    ['java.net.SocketTimeoutException: connect timed out', 'timeout'],
    ['java.net.ConnectException: Connection refused', 'connectionRefused'],
    ['authentication rejected: Permission denied', 'authentication'],
    ['E_KEY_INVALID: invalid private key', 'invalidKey'],
    ['HostKey has been changed', 'hostKey'],
    ['E_HOST_KEY_CHANGED:{"host":"thinker"}', 'hostKey'],
    ['Herdr protocol mismatch: Whip supports 17–20, server reports 16', 'incompatibleProtocol'],
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
      'Herdr protocol mismatch: Whip supports 17–20, server reports 16',
    )).toEqual({
      expectedProtocol: '17–20',
      receivedProtocol: '16',
    });
    expect(connectionErrorContext(
      new Error('Herdr protocol mismatch: Android bridge supports 17 through 20, server reports 21'),
    )).toEqual({
      expectedProtocol: '17 through 20',
      receivedProtocol: '21',
    });
  });

  it('reads native error codes without using any', () => {
    expect(errorCode({ code: 'E_GLOBAL_KEYCHAIN_CANCELLED' })).toBe('E_GLOBAL_KEYCHAIN_CANCELLED');
    expect(errorCode(new Error('failed'))).toBeNull();
    expect(errorCode({ code: 42 })).toBeNull();
  });

  test.each([
    ['E_KEY_PASSPHRASE_REQUIRED', 'connection.enterPassphraseFirst'],
    ['E_KEY_PASSPHRASE_INVALID', 'connection.incorrectPassphrase'],
    ['E_KEY_INVALID', 'connection.unreadableKey'],
  ] as const)('maps private-key error %s to %s', (code, translationKey) => {
    expect(privateKeyErrorTranslationKey({ code })).toBe(translationKey);
  });
});
