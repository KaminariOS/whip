import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Android background monitoring', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const manifest = readFileSync(resolve(__dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8');
  const service = readFileSync(
    resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/HerdrBackgroundService.kt'),
    'utf8',
  );
  const module = readFileSync(
    resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/HerdrBackgroundModule.kt'),
    'utf8',
  );
  const alerts = readFileSync(resolve(__dirname, '../src/services/alerts.ts'), 'utf8');
  const application = readFileSync(
    resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/MainApplication.kt'),
    'utf8',
  );
  const entrypoint = readFileSync(resolve(__dirname, '../index.js'), 'utf8');

  it('declares a policy-visible special-use foreground service', () => {
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE');
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_SPECIAL_USE');
    expect(manifest).toContain('android.permission.WAKE_LOCK');
    expect(manifest).toContain('android:foregroundServiceType="specialUse"');
    expect(manifest).toContain('android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE');
    expect(manifest).toContain('android:stopWithTask="false"');
  });

  it('shows an ongoing notification without restarting an empty monitor process', () => {
    expect(service).toContain('startForeground(');
    expect(service).toContain('.setOngoing(true)');
    expect(service).toContain('return START_NOT_STICKY');
    expect(service).toContain('PowerManager.PARTIAL_WAKE_LOCK');
  });

  it('registers the native package and follows the notification preference', () => {
    expect(application).toContain('add(HerdrBackgroundPackage())');
    expect(app).toContain('startBackgroundMonitoring(hostCount)');
    expect(app).toContain(': stopBackgroundMonitoring()');
  });

  it('holds the wake lock for the full background monitoring lifetime', () => {
    const onCreate = service.slice(service.indexOf('override fun onCreate'), service.indexOf('override fun onStartCommand'));
    expect(onCreate).toContain('acquireWakeLock()');
    expect(service).not.toContain('EXTRA_CONNECTED_HOST_COUNT');
    expect(service).toContain('wakeLock?.let { if (it.isHeld) it.release() }');
  });

  it('keeps React Native timers running for the foreground monitor lifetime', () => {
    expect(service).toContain('class HerdrBackgroundService : HeadlessJsTaskService()');
    expect(service).toContain('keepReactNativeMonitoringActive()');
    expect(service).toContain('HeadlessJsTaskConfig(');
    expect(service).toContain('BACKGROUND_MONITORING_TASK');
    expect(service).toContain('BACKGROUND_MONITORING_STOP_EVENT');
    expect(entrypoint).toContain("AppRegistry.registerHeadlessTask(BACKGROUND_MONITORING_TASK");
    expect(entrypoint).toContain('backgroundMonitoringStops.add(resolve)');
  });

  it('runs an insistent alert only while its notification is active', () => {
    expect(alerts).toContain('armPersistentAgentAlert(');
    expect(module).toContain('Sensor.TYPE_ACCELEROMETER');
    expect(module).toContain('AudioAttributes.USAGE_ALARM');
    expect(module).toContain('isLooping = true');
    expect(module).toContain('notificationManager.activeNotifications.any { it.tag == identifier }');
    expect(module).toContain('notificationManager.cancel(identifier, EXPO_NOTIFICATION_ID)');
    expect(module).toContain('sensorManager.unregisterListener(this)');
    expect(module).toContain('MAX_ALERT_WINDOW_MS = 60_000L');
  });

  it('does not close Herdr event monitoring when the activity is backgrounded', () => {
    expect(app).not.toContain("runtime.eventReconnectTimer || AppState.currentState !== 'active'");
    expect(app).not.toContain("if (!runtime || AppState.currentState !== 'active') return;");
    expect(app).not.toContain("state === 'active') {\n        resumeLiveConnections();\n      } else");
  });

  it('periodically verifies live hosts while monitoring is active', () => {
    expect(app).toContain('const LIVE_HOST_HEALTHCHECK_MS = 15_000;');
    expect(app).toContain('const LIVE_HOST_RECONCILE_MS = 120_000;');
    expect(app).toContain(
      'resumeLiveConnections(false);',
    );
    expect(app).toContain(
      'resumeLiveConnections(true);',
    );
    expect(app).toMatch(
      /shouldRefreshLiveHost\(\s*session,\s*runtime\.eventStatus === 'open',\s*reconcile,?\s*\)/,
    );
    expect(app).toContain('clearInterval(heartbeat);');
    expect(app).toContain('clearInterval(reconciliation);');
  });

  it('retains the SSH runtimes when Android removes the UI task', () => {
    expect(app).toContain('let retainedBackgroundRuntimes: Map<string, LiveRuntime> | null = null;');
    expect(app).toContain('retainedBackgroundRuntimes = runtimes.current;');
    expect(app).toContain('disposeRuntimes(retained);');
  });
});
