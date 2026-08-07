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
});
