import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('app logs', () => {
  const methods = ['debug', 'info', 'log', 'warn', 'error'] as const;
  const originalConsole = Object.fromEntries(
    methods.map(method => [method, console[method]]),
  );

  beforeEach(() => {
    jest.resetModules();
    for (const method of methods) console[method] = jest.fn();
  });

  afterEach(() => {
    for (const method of methods) console[method] = originalConsole[method];
  });

  it('captures console output with useful object and error formatting', () => {
    const originalWarn = console.warn;
    const logs =
      require('../src/services/appLogs') as typeof import('../src/services/appLogs');
    logs.installAppLogCapture();

    const circular: Record<string, unknown> = { value: 7 };
    circular.self = circular;
    console.warn('Connection warning', circular, new Error('offline'));

    const entries = logs.getAppLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('App log capture started.');
    expect(entries[1]).toMatchObject({ level: 'warn' });
    expect(entries[1].message).toContain(
      'Connection warning {"value":7,"self":"[Circular]"}',
    );
    expect(entries[1].message).toContain('Error: offline');
    expect(originalWarn).toHaveBeenCalledWith(
      'Connection warning',
      circular,
      expect.any(Error),
    );
  });

  it('keeps only the latest 500 entries', () => {
    const logs =
      require('../src/services/appLogs') as typeof import('../src/services/appLogs');
    logs.installAppLogCapture();

    for (let index = 0; index < 505; index += 1) console.log(`entry-${index}`);

    const entries = logs.getAppLogEntries();
    expect(entries).toHaveLength(500);
    expect(entries[0].message).toBe('entry-5');
    expect(entries[499].message).toBe('entry-504');
  });

  it('defers and coalesces subscriber updates', async () => {
    const logs =
      require('../src/services/appLogs') as typeof import('../src/services/appLogs');
    logs.installAppLogCapture();
    const listener = jest.fn(() =>
      console.warn('warning emitted while rendering a subscriber'),
    );
    const unsubscribe = logs.subscribeToAppLogs(listener);

    console.warn('render warning');
    console.error('render error');

    expect(listener).not.toHaveBeenCalled();
    expect(logs.getAppLogEntries().at(-1)?.message).toBe('render error');

    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(logs.getAppLogEntries().at(-1)?.message).toBe('render error');

    unsubscribe();
  });

  it('starts capture before loading the app and exposes copy-all in More', () => {
    const entry = readFileSync(resolve(__dirname, '../index.js'), 'utf8');
    const more = readFileSync(
      resolve(__dirname, '../src/components/MoreScreen.tsx'),
      'utf8',
    );
    const screen = readFileSync(
      resolve(__dirname, '../src/components/AppLogsScreen.tsx'),
      'utf8',
    );

    expect(entry.indexOf("import './src/installAppLogCapture';")).toBeLessThan(
      entry.indexOf("import App from './App';"),
    );
    expect(more).toContain('<AppLogsSection />');
    expect(screen).toContain(
      '<AppLogsModal visible onClose={() => setVisible(false)} />',
    );
    expect(screen).toContain('Clipboard.setString(formatAppLogs(entries))');
    expect(screen).toContain("t('appLogs.privacy')");
  });
});
