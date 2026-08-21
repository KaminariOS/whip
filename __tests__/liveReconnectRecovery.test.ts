import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');
const herd = readFileSync(resolve(__dirname, '../src/components/HerdScreen.tsx'), 'utf8');

describe('live connection recovery', () => {
  test('enters a cooldown instead of permanently stopping after bounded retries', () => {
    expect(app).toContain('LIVE_HOST_RECONNECT_COOLDOWN_MS = 30_000');
    expect(app).toContain('runtime.reconnectAttempts = 0;\n        scheduleReconnect(sessionId, cause);');
  });

  test('restarts exhausted connections on resume and all transports on network change', () => {
    expect(app).toContain("restartLiveConnections('app-resume');");
    expect(app).toContain("restartLiveConnections('app-resume');\n        resumeLiveConnections(false);");
    expect(app).toContain("restartLiveConnections('network-change');");
    expect(app).toContain('HerdrClient.addNetworkChangeListener');
    expect(app).toContain('runtime.refresh.invalidate();\n      scheduleReconnect(');
  });

  test('does not expose automatic recovery syncs as pull-to-refresh activity', () => {
    expect(herd).toContain('refreshing={pullRefreshing}');
    expect(herd).toContain('onRefresh={refreshFromPull}');
    expect(herd).not.toContain('const refreshing = scopedQueues.some(queue => queue.refreshing)');
  });

  test('preserves jump-host routing when replacing the control connection', () => {
    expect(client).toContain('this.connectSsh(profile, port, this.jumpProfiles)');
  });

  test('records control, event-stream, snapshot, and latency recovery diagnostics', () => {
    expect(app).toContain("'control-reconnect-scheduled'");
    expect(app).toContain("'control-reconnect-failed'");
    expect(app).toContain("'control-reconnect-recovered'");
    expect(app).toContain("'event-stream-closed'");
    expect(app).toContain("'event-stream-recovered'");
    expect(app).toContain("'snapshot-refresh-failed'");
    expect(app).toContain("'snapshot-status-divergence'");
    expect(app).toContain("'latency-probe-failed'");
    expect(app).toContain("'latency-probe-recovered'");
    expect(app).toContain("'agent-status-event'");
    expect(app).toContain("'app-state-changed'");
  });
});
