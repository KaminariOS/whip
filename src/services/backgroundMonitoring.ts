import { NativeModules, Platform } from 'react-native';

interface HerdrBackgroundNativeModule {
  start(hostCount: number, connectedHostCount: number): Promise<void>;
  stop(): Promise<void>;
  armPersistentAlert(
    notificationIdentifier: string,
    channelId: string,
    timeoutMs: number,
  ): Promise<void>;
}

function nativeModule(): HerdrBackgroundNativeModule | null {
  if (Platform.OS !== 'android') return null;
  const module = NativeModules.HerdrBackground as HerdrBackgroundNativeModule | undefined;
  if (!module) {
    throw new Error('HerdrBackground native module is not installed in this build');
  }
  return module;
}

export async function startBackgroundMonitoring(
  hostCount: number,
  connectedHostCount: number,
): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  const monitored = Math.max(1, Math.trunc(hostCount));
  const connected = Math.min(monitored, Math.max(0, Math.trunc(connectedHostCount)));
  await module.start(monitored, connected);
}

export async function stopBackgroundMonitoring(): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.stop();
}

export async function armPersistentAgentAlert(
  notificationIdentifier: string,
  channelId: string,
  timeoutMs: number,
): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.armPersistentAlert(notificationIdentifier, channelId, timeoutMs);
}
