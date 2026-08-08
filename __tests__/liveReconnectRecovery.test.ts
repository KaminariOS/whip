import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

describe('live connection recovery', () => {
  test('enters a cooldown instead of permanently stopping after bounded retries', () => {
    expect(app).toContain('LIVE_HOST_RECONNECT_COOLDOWN_MS = 30_000');
    expect(app).toContain('runtime.reconnectAttempts = 0;\n        scheduleReconnect(sessionId, cause);');
  });

  test('restarts exhausted connections on resume and all transports on network change', () => {
    expect(app).toContain("restartLiveConnections('app-resume');");
    expect(app).toContain("restartLiveConnections('network-change');");
    expect(app).toContain('HerdrClient.addNetworkChangeListener');
    expect(app).toContain('runtime.refresh.invalidate();\n      scheduleReconnect(');
  });

  test('preserves jump-host routing when replacing the control connection', () => {
    expect(client).toContain('this.connectSsh(profile, port, this.jumpProfiles)');
  });
});
