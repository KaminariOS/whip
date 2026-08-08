import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('host latency measurement', () => {
  it('does not label full snapshot duration as network latency', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(app).toContain('runtime.client.measureLatency().catch(() => null)');
    expect(app).toContain('runtime.client.snapshot()');
    expect(app).not.toContain('elapsedLatencyMs');
    expect(app).not.toMatch(/startedAt[\s\S]{0,160}client\.snapshot\(\)/);
    expect(app.indexOf('runtime.client.measureLatency()')).toBeLessThan(
      app.indexOf('runtime.client.snapshot()'),
    );
  });

  it('polls lightweight latency while the Hosts tab is visible', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(app).toContain('const VISIBLE_HOST_LATENCY_POLL_MS = 3_000;');
    expect(app).toContain("if (navigation.tab !== 'hosts' || appAccessLocked) return;");
    expect(app).toContain('const interval = setInterval(measureVisibleHostLatencies, VISIBLE_HOST_LATENCY_POLL_MS);');
    expect(app).toContain('setLiveSessions(current => applyLiveHostLatency(current, session.id, latencyMs));');
    expect(app).toContain("if (session.status !== 'connected') continue;");
    expect(app).toContain('latencyPingsInFlight.current.get(session.id) === runtime');
    expect(app).toContain('clearInterval(interval);');
  });
});
