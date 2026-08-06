import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import { Platform, Vibration } from 'react-native';

import type { AgentInfo } from '../types';
import type { AgentNotificationTarget } from '../lib/notificationNavigation';
import { agentNotificationTitle } from '../lib/agentStatusEvents';
import { armPersistentAgentAlert } from './backgroundMonitoring';
import i18n from '../i18n';

const PERSISTENT_CHANNEL_ID = 'agent-state-v3';
const BRIEF_CHANNEL_ID = 'agent-state-brief-v1';
const ALERT_VIBRATION_PATTERN = [
  300, 100, 300, 100, 300, 100, 300, 2000,
  300, 100, 300, 100, 300, 100, 300, 2000,
  300, 100, 300, 100, 300, 100, 300, 2000,
];
const BRIEF_VIBRATION_PATTERN = [0, 200];
const SPEECH_TIMEOUT_MS = 10_000;
const DEFAULT_PERSISTENT_ALERT_TIMEOUT_MS = 30_000;

export type AgentAlertDuration = 'brief' | 'persistent';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
    priority: Notifications.AndroidNotificationPriority.MAX,
  }),
});

export async function prepareAlerts(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(PERSISTENT_CHANNEL_ID, {
      name: i18n.t('alerts.channelName'),
      importance: Notifications.AndroidImportance.HIGH,
      bypassDnd: true,
      enableLights: true,
      enableVibrate: true,
      vibrationPattern: ALERT_VIBRATION_PATTERN,
    });
    await Notifications.setNotificationChannelAsync(BRIEF_CHANNEL_ID, {
      name: i18n.t('alerts.channelName'),
      importance: Notifications.AndroidImportance.HIGH,
      enableLights: true,
      enableVibrate: true,
      vibrationPattern: BRIEF_VIBRATION_PATTERN,
    });
  }
  await Notifications.requestPermissionsAsync();
}

export async function alertAgent(
  agent: AgentInfo,
  speak: boolean,
  target: Pick<AgentNotificationTarget, 'hostId' | 'paneId'>,
  tabName?: string,
  duration: AgentAlertDuration = 'persistent',
  persistentAlertTimeoutMs: number = DEFAULT_PERSISTENT_ALERT_TIMEOUT_MS,
): Promise<void> {
  const title = agentNotificationTitle(agent, tabName, {
    needsYou: name => i18n.t('alerts.needsYou', { name }),
    finished: name => i18n.t('alerts.finished', { name }),
  });
  const body = agent.title || agent.custom_status || i18n.t('alerts.agentState', { status: agent.agent_status });

  if (speak) await speakBeforeAlert(title);
  if (Platform.OS !== 'android') Vibration.vibrate();
  const persistent = duration === 'persistent';
  const channelId = persistent ? PERSISTENT_CHANNEL_ID : BRIEF_CHANNEL_ID;
  const notificationIdentifier = await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: 'default',
      vibrate: persistent ? ALERT_VIBRATION_PATTERN : BRIEF_VIBRATION_PATTERN,
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: target,
    },
    trigger: { channelId },
  });
  if (Platform.OS === 'android' && persistent) {
    armPersistentAgentAlert(
      notificationIdentifier,
      PERSISTENT_CHANNEL_ID,
      persistentAlertTimeoutMs,
    ).catch(() => undefined);
  }
}

async function speakBeforeAlert(title: string): Promise<void> {
  await Speech.stop().catch(() => undefined);
  await new Promise<void>(resolve => {
    let completed = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (completed) return;
      completed = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };

    timeout = setTimeout(() => {
      Speech.stop().catch(() => undefined).finally(finish);
    }, SPEECH_TIMEOUT_MS);
    try {
      Speech.speak(title, {
        language: i18n.resolvedLanguage === 'zh-Hant' ? 'zh-TW' : 'en-US',
        onDone: finish,
        onStopped: finish,
        onError: finish,
      });
    } catch {
      finish();
    }
  });
}
