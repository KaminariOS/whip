import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import { Platform, Vibration } from 'react-native';

import type { AgentInfo } from '../types';
import type { AgentNotificationTarget } from '../lib/notificationNavigation';
import { agentNotificationTitle } from '../lib/agentStatusEvents';
import { armPersistentAgentAlert, dismissPersistentAgentAlert } from './backgroundMonitoring';
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
type ActiveAgentNotification = {
  targetKey: string;
  persistent: boolean;
};

const activeAgentNotifications = new Map<string, ActiveAgentNotification>();
const pendingAgentAlertCounts = new Map<string, number>();
const tabDismissalGenerations = new Map<string, number>();
let alertDismissalGeneration = 0;
let persistentAgentNotificationId: string | null = null;
let speakingAgentAlertTargetKey: string | null = null;

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
  const dismissalGeneration = alertDismissalGeneration;
  const targetKey = agentAlertTargetKey(target.hostId, agent.tab_id);
  const tabDismissalGeneration = tabDismissalGenerations.get(targetKey) ?? 0;
  const wasDismissed = () => (
    dismissalGeneration !== alertDismissalGeneration
    || tabDismissalGeneration !== (tabDismissalGenerations.get(targetKey) ?? 0)
  );
  const title = agentNotificationTitle(agent, tabName, {
    needsYou: name => i18n.t('alerts.needsYou', { name }),
    finished: name => i18n.t('alerts.finished', { name }),
  });
  const body = agent.title || i18n.t('alerts.agentState', { status: agent.agent_status });

  pendingAgentAlertCounts.set(targetKey, (pendingAgentAlertCounts.get(targetKey) ?? 0) + 1);
  try {
    if (speak) {
      speakingAgentAlertTargetKey = targetKey;
      try {
        await speakBeforeAlert(title);
      } finally {
        if (speakingAgentAlertTargetKey === targetKey) speakingAgentAlertTargetKey = null;
      }
    }
    if (wasDismissed()) return;
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
    if (wasDismissed()) {
      await Notifications.dismissNotificationAsync(notificationIdentifier).catch(() => undefined);
      return;
    }
    activeAgentNotifications.set(notificationIdentifier, { targetKey, persistent });
    if (Platform.OS === 'android' && persistent) {
      persistentAgentNotificationId = notificationIdentifier;
      armPersistentAgentAlert(
        notificationIdentifier,
        PERSISTENT_CHANNEL_ID,
        persistentAlertTimeoutMs,
      ).catch(() => {
        if (persistentAgentNotificationId === notificationIdentifier) {
          persistentAgentNotificationId = null;
        }
      });
    }
  } finally {
    const remaining = (pendingAgentAlertCounts.get(targetKey) ?? 1) - 1;
    if (remaining > 0) pendingAgentAlertCounts.set(targetKey, remaining);
    else pendingAgentAlertCounts.delete(targetKey);
  }
}

export async function dismissAgentAlerts(): Promise<void> {
  alertDismissalGeneration += 1;
  const notificationIds = [...activeAgentNotifications.keys()];
  activeAgentNotifications.clear();
  persistentAgentNotificationId = null;
  speakingAgentAlertTargetKey = null;
  await Speech.stop().catch(() => undefined);
  await Promise.all(notificationIds.map(identifier => (
    Notifications.dismissNotificationAsync(identifier).catch(() => undefined)
  )));
  await dismissPersistentAgentAlert().catch(() => undefined);
}

export async function dismissAgentAlertsForTab(hostId: string, tabId: string): Promise<void> {
  const targetKey = agentAlertTargetKey(hostId, tabId);
  const notificationIds = [...activeAgentNotifications]
    .filter(([, alert]) => alert.targetKey === targetKey)
    .map(([identifier]) => identifier);
  const pending = pendingAgentAlertCounts.has(targetKey);
  if (!pending && notificationIds.length === 0) return;

  tabDismissalGenerations.set(targetKey, (tabDismissalGenerations.get(targetKey) ?? 0) + 1);
  for (const identifier of notificationIds) activeAgentNotifications.delete(identifier);

  if (speakingAgentAlertTargetKey === targetKey) {
    speakingAgentAlertTargetKey = null;
    await Speech.stop().catch(() => undefined);
  }
  await Promise.all(notificationIds.map(identifier => (
    Notifications.dismissNotificationAsync(identifier).catch(() => undefined)
  )));
  if (persistentAgentNotificationId && notificationIds.includes(persistentAgentNotificationId)) {
    persistentAgentNotificationId = null;
    await dismissPersistentAgentAlert().catch(() => undefined);
  }
}

function agentAlertTargetKey(hostId: string, tabId: string): string {
  return JSON.stringify([hostId, tabId]);
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
        language: {
          'zh-Hant': 'zh-TW',
          'zh-Hans': 'zh-CN',
          ja: 'ja-JP',
          es: 'es-ES',
          en: 'en-US',
        }[i18n.resolvedLanguage || 'en'] || 'en-US',
        onDone: finish,
        onStopped: finish,
        onError: finish,
      });
    } catch {
      finish();
    }
  });
}
