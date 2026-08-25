describe('app log collection', () => {
  const originalInfo = console.info;

  beforeEach(() => {
    jest.resetModules();
    console.info = jest.fn();
  });

  afterEach(() => {
    console.info = originalInfo;
  });

  test('collects only while developer logging is enabled and clears on disable', () => {
    const logs =
      require('../src/services/appLogs') as typeof import('../src/services/appLogs');

    logs.setAppLogCaptureEnabled(true);
    console.info('enabled entry');
    expect(logs.formatAppLogs()).toContain('enabled entry');

    logs.setAppLogCaptureEnabled(false);
    console.info('disabled entry');
    expect(logs.getAppLogEntries()).toEqual([]);
  });
});
