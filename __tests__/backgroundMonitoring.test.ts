import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Android background monitoring', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const manifest = readFileSync(resolve(__dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8');
  const service = readFileSync(
    resolve(__dirname, '../android/app/src/main/java/com/herdr/HerdrBackgroundService.kt'),
    'utf8',
  );
  const application = readFileSync(
    resolve(__dirname, '../android/app/src/main/java/com/herdr/MainApplication.kt'),
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

  it('registers the native package and follows the notification preference', () => {
    expect(application).toContain('add(HerdrBackgroundPackage())');
    expect(app).toContain('startBackgroundMonitoring(hostCount)');
    expect(app).toContain(': stopBackgroundMonitoring()');
  });

  it('does not close Herdr event monitoring when the activity is backgrounded', () => {
    expect(app).not.toContain("runtime.eventReconnectTimer || AppState.currentState !== 'active'");
    expect(app).not.toContain("if (!runtime || AppState.currentState !== 'active') return;");
    expect(app).not.toContain("state === 'active') {\n        resumeLiveConnections();\n      } else");
  });

  it('retains the SSH runtimes when Android removes the UI task', () => {
    expect(app).toContain('let retainedBackgroundRuntimes: Map<string, LiveRuntime> | null = null;');
    expect(app).toContain('retainedBackgroundRuntimes = runtimes.current;');
    expect(app).toContain('disposeRuntimes(retained);');
  });
});
