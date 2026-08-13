import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Android background monitoring', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const manifest = readFileSync(resolve(__dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8');
  const service = readFileSync(
    resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/HerdrBackgroundService.kt'),
    'utf8',
  );
  const notificationIcon = readFileSync(
    resolve(__dirname, '../android/app/src/main/res/drawable/ic_notification_whip.xml'),
    'utf8',
  );
  const notificationIconSource = readFileSync(
    resolve(__dirname, '../assets/notification-icon.svg'),
    'utf8',
  );
  const launcherForeground = readFileSync(
    resolve(
      __dirname,
      '../android/app/src/main/res/drawable/ic_launcher_whip_foreground.xml',
    ),
    'utf8',
  );
  const adaptiveLauncher = readFileSync(
    resolve(
      __dirname,
      '../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_whip_adaptive.xml',
    ),
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

  it('uses the Whip vector for native and Expo notification icons', () => {
    expect(service).toContain('.setSmallIcon(R.drawable.ic_notification_whip)');
    expect(service).not.toContain('android.R.drawable.stat_notify_sync');
    expect(manifest).toContain('expo.modules.notifications.default_notification_icon');
    expect(manifest).toContain('com.google.firebase.messaging.default_notification_icon');
    expect(manifest.match(/@drawable\/ic_notification_whip/g)).toHaveLength(2);
    expect(notificationIcon).toContain('<vector');
    expect(notificationIcon).toContain('android:pathData=');
    expect(notificationIconSource).toContain('<svg');
    expect(notificationIconSource).toContain('A clenched mechanical hand beneath a curling whip.');
  });

  it('uses a versioned launcher resource so notification cards refresh their cached app icon', () => {
    expect(manifest).toContain('android:icon="@mipmap/ic_launcher_whip_adaptive"');
    expect(manifest).toContain(
      'android:roundIcon="@mipmap/ic_launcher_whip_adaptive_round"',
    );
    expect(adaptiveLauncher).toContain('<adaptive-icon');
    expect(adaptiveLauncher).toContain('@drawable/ic_launcher_whip_foreground');
    expect(launcherForeground).toContain('<vector');
    expect(launcherForeground).toContain('android:scaleX="0.70"');
    expect(launcherForeground.match(/<path/g)).toHaveLength(1567);
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

  it('runs an insistent alert only while its notification is active', () => {
    expect(alerts).toContain('armPersistentAgentAlert(');
    expect(module).toContain('Sensor.TYPE_ACCELEROMETER');
    expect(module).toContain('findPrivateListeningDevice(audioManager)');
    expect(module).toContain('AudioAttributes.USAGE_MEDIA');
    expect(module).toContain('Build.VERSION.SDK_INT >= Build.VERSION_CODES.P');
    expect(module).toContain('setPreferredDevice(device)');
    expect(module).toContain('AudioAttributes.USAGE_ALARM');
    expect(module).toContain('isLooping = true');
    expect(module).toContain('notificationManager.activeNotifications.any { it.tag == identifier }');
    expect(module).toContain('notificationManager.cancel(identifier, EXPO_NOTIFICATION_ID)');
    expect(module).toContain('sensorManager.unregisterListener(this)');
    expect(module).toContain('MAX_ALERT_WINDOW_MS = 60_000L');
  });

  it('dismisses agent alerts when the app returns to the foreground', () => {
    expect(app).toContain("const returnedToForeground = previousState !== 'active' && state === 'active';");
    expect(app).toContain('if (returnedToForeground) dismissAgentAlerts().catch(() => undefined);');
    expect(alerts).toContain('Notifications.dismissNotificationAsync(identifier)');
    expect(module).toContain('fun dismissPersistentAlert(promise: Promise)');
    expect(module).toContain('stopPersistentAlert("App returned to the foreground")');
  });

  it('does not close Herdr event monitoring when the activity is backgrounded', () => {
    expect(app).not.toContain("runtime.eventReconnectTimer || AppState.currentState !== 'active'");
    expect(app).not.toContain("if (!runtime || AppState.currentState !== 'active') return;");
    expect(app).not.toContain("state === 'active') {\n        resumeLiveConnections();\n      } else");
  });

  it('periodically verifies live hosts while the app is active', () => {
    expect(app).toContain('const LIVE_HOST_HEALTHCHECK_MS = 15_000;');
    expect(app).toContain('const LIVE_HOST_RECONCILE_MS = 120_000;');
    expect(app).toContain(
      "if (AppState.currentState === 'active') resumeLiveConnections(false);",
    );
    expect(app).toContain(
      "if (AppState.currentState === 'active') resumeLiveConnections(true);",
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
