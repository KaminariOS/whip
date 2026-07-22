import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import { Platform, Vibration } from 'react-native';

import type { AgentInfo } from '../types';
import type { AgentNotificationTarget } from '../lib/notificationNavigation';
import { agentNotificationTitle } from '../lib/agentStatusEvents';
import { armPersistentAgentAlert } from './backgroundMonitoring';
import i18n from '../i18n';

const CHANNEL_ID = 'agent-state-v3';
const ALERT_VIBRATION_PATTERN = [
  300, 100, 300, 100, 300, 100, 300, 2000,
  300, 100, 300, 100, 300, 100, 300, 2000,
  300, 100, 300, 100, 300, 100, 300, 2000,
];
const PERSISTENT_ALERT_TIMEOUT_MS = 60_000;

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
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: i18n.t('alerts.channelName'),
      importance: Notifications.AndroidImportance.HIGH,
      bypassDnd: true,
      enableLights: true,
      enableVibrate: true,
      vibrationPattern: ALERT_VIBRATION_PATTERN,
    });
  }
  await Notifications.requestPermissionsAsync();
}

export async function alertAgent(
  agent: AgentInfo,
  speak: boolean,
  target: Pick<AgentNotificationTarget, 'hostId' | 'paneId'>,
  tabName?: string,
): Promise<void> {
  const title = agentNotificationTitle(agent, tabName, {
    needsYou: name => i18n.t('alerts.needsYou', { name }),
    finished: name => i18n.t('alerts.finished', { name }),
  });
  const body = agent.title || agent.custom_status || i18n.t('alerts.agentState', { status: agent.agent_status });

  if (Platform.OS !== 'android') Vibration.vibrate();
  const notificationIdentifier = await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: 'default',
      vibrate: ALERT_VIBRATION_PATTERN,
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: target,
    },
    trigger: { channelId: CHANNEL_ID },
  });
  if (Platform.OS === 'android') {
    armPersistentAgentAlert(
      notificationIdentifier,
      CHANNEL_ID,
      PERSISTENT_ALERT_TIMEOUT_MS,
    ).catch(() => undefined);
  }
  if (speak) {
    Speech.stop();
    Speech.speak(title, { language: i18n.resolvedLanguage === 'zh-Hant' ? 'zh-TW' : 'en-US' });
  }
}
