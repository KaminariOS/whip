describe('network diagnostics', () => {
  const originalConsole = {
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  beforeEach(() => {
    console.info = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });

  it('writes compact structured entries through the captured console', () => {
    const { recordNetworkDiagnostic } =
      require('../src/services/networkDiagnostics') as typeof import('../src/services/networkDiagnostics');

    recordNetworkDiagnostic('warn', 'event-stream-closed', {
      sessionId: 'host-1',
      attempt: 2,
      omitted: undefined,
    });

    expect(console.warn).toHaveBeenCalledWith(
      '[NetworkDiagnostics] event-stream-closed {"sessionId":"host-1","attempt":2}',
    );
  });

  it('normalizes multiline errors and bounds their size', () => {
    const { networkErrorMessage } =
      require('../src/services/networkDiagnostics') as typeof import('../src/services/networkDiagnostics');

    expect(networkErrorMessage(new Error('channel\n send   error'))).toBe(
      'channel send error',
    );
    expect(networkErrorMessage('x'.repeat(2_000))).toHaveLength(1_000);
  });
});
