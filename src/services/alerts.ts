import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import { Platform, Vibration } from 'react-native';

import type { AgentInfo } from '../types';
import type { AgentNotificationTarget } from '../lib/notificationNavigation';

const CHANNEL_ID = 'agent-state';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function prepareAlerts(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Agent state',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 120, 90, 180],
    });
  }
  await Notifications.requestPermissionsAsync();
}

export async function alertAgent(
  agent: AgentInfo,
  speak: boolean,
  target: Pick<AgentNotificationTarget, 'hostId' | 'paneId'>,
): Promise<void> {
  const name = agent.display_agent || agent.name || agent.agent || agent.pane_id;
  const blocked = agent.agent_status === 'blocked';
  const title = blocked ? `${name} needs you` : `${name} finished`;
  const body = agent.title || agent.custom_status || `Agent is ${agent.agent_status}`;

  Vibration.vibrate(blocked ? [0, 100, 90, 180] : [0, 80]);
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: 'default',
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: target,
    },
    trigger: { channelId: CHANNEL_ID },
  });
  if (speak) {
    Speech.stop();
    Speech.speak(title);
  }
}
