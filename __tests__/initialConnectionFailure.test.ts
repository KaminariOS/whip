import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

describe('initial host connection failures', () => {
  test('publishes a live host only after SSH and the initial snapshot succeed', () => {
    const connect = app.indexOf('await runtime.client.connect(nextProfile);');
    const snapshot = app.indexOf('const initial = await runtime.client.initialSnapshot();');
    const publishRuntime = app.indexOf('runtimes.current.set(sessionId, runtime);', connect);
    const publishSession = app.indexOf('let next = openLiveHostSession(', connect);

    expect(connect).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(connect);
    expect(publishRuntime).toBeGreaterThan(snapshot);
    expect(publishSession).toBeGreaterThan(snapshot);
  });

  test('disconnects a partial client instead of treating initial failure as a reconnect', () => {
    expect(app).toContain('if (liveSessionOpened) {\n          scheduleReconnect(nextProfile.id, error);');
    expect(app).toContain('runtime.refresh.invalidate();\n          runtime.client.disconnect();');
  });
});
