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

export function classifyConnectionError(error: unknown): ConnectionErrorKind {
  const message = errorText(error).toLowerCase();

  if (/herdr protocol mismatch/.test(message)) return 'incompatibleProtocol';
  if (/hostkey|host key/.test(message)) return 'hostKey';
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
