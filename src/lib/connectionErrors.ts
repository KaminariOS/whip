export type ConnectionErrorKind =
  | 'authentication'
  | 'connectionRefused'
  | 'herdrUnavailable'
  | 'hostKey'
  | 'incompatibleProtocol'
  | 'invalidKey'
  | 'timeout'
  | 'unreachable'
  | 'unknown';

export const connectionErrorTranslationKeys: Record<ConnectionErrorKind, string> = {
  authentication: 'app.connectAuthenticationError',
  connectionRefused: 'app.connectRefusedError',
  herdrUnavailable: 'app.connectHerdrUnavailableError',
  hostKey: 'app.connectHostKeyError',
  incompatibleProtocol: 'app.connectProtocolError',
  invalidKey: 'app.connectKeyError',
  timeout: 'app.connectTimeoutError',
  unreachable: 'app.connectUnreachableError',
  unknown: 'app.connectUnknownError',
};

export type PrivateKeyErrorTranslationKey =
  | 'connection.enterPassphraseFirst'
  | 'connection.incorrectPassphrase'
  | 'connection.unreadableKey';

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

export function privateKeyErrorTranslationKey(error: unknown): PrivateKeyErrorTranslationKey {
  const code = errorCode(error);
  if (code === 'E_KEY_PASSPHRASE_REQUIRED') return 'connection.enterPassphraseFirst';
  if (code === 'E_KEY_PASSPHRASE_INVALID') return 'connection.incorrectPassphrase';
  return 'connection.unreadableKey';
}

export function connectionErrorContext(error: unknown): Record<string, string> {
  if (error && typeof error === 'object' && 'expected' in error) {
    const mismatch = error as { expected?: unknown; received?: unknown };
    if (typeof mismatch.expected === 'number' || typeof mismatch.expected === 'string') {
      return {
        expectedProtocol: String(mismatch.expected),
        receivedProtocol: mismatch.received === undefined
          ? 'unavailable'
          : String(mismatch.received),
      };
    }
  }

  const match = errorText(error).match(
    /(?:Whip|Android bridge) supports (.+?), server reports ([^\r\n]+)/i,
  );
  return match
    ? {
      expectedProtocol: match[1],
      receivedProtocol: match[2].trim(),
    }
    : {};
}

export function classifyConnectionError(error: unknown): ConnectionErrorKind {
  switch (errorCode(error)) {
    case 'AUTHENTICATION_FAILED':
      return 'authentication';
    case 'HOST_KEY_UNKNOWN':
    case 'HOST_KEY_CHANGED':
      return 'hostKey';
    case 'INVALID_PRIVATE_KEY':
      return 'invalidKey';
    case 'CONNECTION_REFUSED':
      return 'connectionRefused';
    case 'CONNECTION_TIMEOUT':
      return 'timeout';
    case 'HOST_UNREACHABLE':
    case 'CHANNEL_UNAVAILABLE':
    case 'SESSION_CLOSED':
      return 'unreachable';
  }

  // Preserve friendly handling for product-layer and older native errors that
  // do not originate from the structured Rust transport boundary.
  const message = errorText(error).toLowerCase();

  if (/herdr protocol mismatch/.test(message)) return 'incompatibleProtocol';
  if (/hostkey|host key|e_host_key/.test(message)) return 'hostKey';
  if (
    /private key|privatekey|key passphrase|e_key_|invalid key|invalidkey/.test(message)
  ) {
    return 'invalidKey';
  }
  if (
    /auth fail|authentication fail|authentication rejected|userauth fail|permission denied/.test(message)
  ) {
    return 'authentication';
  }
  if (/connection refused|econnrefused/.test(message)) return 'connectionRefused';
  if (/timed? ?out|etimedout/.test(message)) return 'timeout';
  if (
    /unknownhost|unknown host|unable to resolve|name or service not known|network is unreachable|no route to host|enetunreach|ehostunreach|connection reset|connection lost|broken pipe|session is down|socket is not established/.test(message)
  ) {
    return 'unreachable';
  }
  if (/herdr/.test(message)) return 'herdrUnavailable';
  return 'unknown';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
