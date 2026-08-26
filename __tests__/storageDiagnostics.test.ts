import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageErrorMessage,
  storageParseErrorDetails,
} from '../src/services/storageDiagnostics';

describe('storage diagnostics', () => {
  const originalError = console.error;

  beforeEach(() => {
    console.error = jest.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  test('writes compact structured entries through the captured console', () => {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'terminal-history',
      operation: 'getItem',
      omitted: undefined,
    });

    expect(console.error).toHaveBeenCalledWith(
      '[StorageDiagnostics] storage-read-failed {"store":"terminal-history","operation":"getItem"}',
    );
  });

  test('normalizes bounded errors and includes safe name and code fields', () => {
    const error = Object.assign(new Error(`read\n${'x'.repeat(2_000)}`), { code: 42 });

    expect(storageErrorMessage(error)).toHaveLength(1_000);
    expect(storageErrorDetails(error)).toMatchObject({
      errorName: 'Error',
      errorCode: 42,
    });
  });

  test('does not include persisted content in parse error details', () => {
    const details = storageParseErrorDetails(new SyntaxError('Unexpected private persisted content'));

    expect(details).toEqual({
      error: 'Stored JSON could not be parsed or validated',
      errorName: 'SyntaxError',
      errorCode: undefined,
    });
    expect(JSON.stringify(details)).not.toContain('private persisted content');
  });
});
