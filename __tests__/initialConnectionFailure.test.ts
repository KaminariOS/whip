import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

describe('initial host connection failures', () => {
  test('publishes a live host only after SSH and the initial snapshot succeed', () => {
    const connect = app.indexOf('await runtime.client.connect(nextProfile, jumpProfiles);');
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

  test('does not rewrite an unchanged saved host before opening SSH', () => {
    expect(app).toContain('await connect(nextProfile, { persistProfile: false });');
  });

  test('navigates after the snapshot without waiting for event or recency persistence', () => {
    const publishSession = app.indexOf('liveSessionOpened = true;');
    const navigate = app.indexOf('if (navigate) {', publishSession);
    const openEvents = app.indexOf('ensureEventStream(sessionId, initial)', navigate);
    const markUsed = app.indexOf('markHostConnected(saved.hosts, nextProfile.id)', navigate);

    expect(navigate).toBeGreaterThan(publishSession);
    expect(openEvents).toBeGreaterThan(navigate);
    expect(markUsed).toBeGreaterThan(navigate);
    expect(app).not.toContain('await ensureEventStream(sessionId, initial)');
    expect(app).not.toContain('await markHostConnected(saved.hosts, nextProfile.id)');
  });
});
