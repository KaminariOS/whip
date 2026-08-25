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
  paneTargetKey: string;
  tabTargetKey: string;
  persistent: boolean;
};
type AgentAlertTargets = Pick<ActiveAgentNotification, 'paneTargetKey' | 'tabTargetKey'>;

const activeAgentNotifications = new Map<string, ActiveAgentNotification>();
const pendingPaneAlertCounts = new Map<string, number>();
const pendingTabAlertCounts = new Map<string, number>();
const paneDismissalGenerations = new Map<string, number>();
const tabDismissalGenerations = new Map<string, number>();
let alertDismissalGeneration = 0;
let persistentAgentNotificationId: string | null = null;
let speakingAgentAlertTargets: AgentAlertTargets | null = null;

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
  const paneTargetKey = agentAlertTargetKey(target.hostId, target.paneId);
  const tabTargetKey = agentAlertTargetKey(target.hostId, agent.tab_id);
  const targets = { paneTargetKey, tabTargetKey };
  const paneDismissalGeneration = paneDismissalGenerations.get(paneTargetKey) ?? 0;
  const tabDismissalGeneration = tabDismissalGenerations.get(tabTargetKey) ?? 0;
  const wasDismissed = () => (
    dismissalGeneration !== alertDismissalGeneration
    || paneDismissalGeneration !== (paneDismissalGenerations.get(paneTargetKey) ?? 0)
    || tabDismissalGeneration !== (tabDismissalGenerations.get(tabTargetKey) ?? 0)
  );
  const title = agentNotificationTitle(agent, tabName, {
    needsYou: name => i18n.t('alerts.needsYou', { name }),
    finished: name => i18n.t('alerts.finished', { name }),
  });
  const body = agent.title || i18n.t('alerts.agentState', { status: agent.agent_status });

  incrementAlertCount(pendingPaneAlertCounts, paneTargetKey);
  incrementAlertCount(pendingTabAlertCounts, tabTargetKey);
  try {
    if (speak) {
      speakingAgentAlertTargets = targets;
      try {
        await speakBeforeAlert(title);
      } finally {
        if (speakingAgentAlertTargets === targets) speakingAgentAlertTargets = null;
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
    activeAgentNotifications.set(notificationIdentifier, { ...targets, persistent });
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
    decrementAlertCount(pendingPaneAlertCounts, paneTargetKey);
    decrementAlertCount(pendingTabAlertCounts, tabTargetKey);
  }
}

export async function dismissAgentAlerts(): Promise<void> {
  alertDismissalGeneration += 1;
  const notificationIds = [...activeAgentNotifications.keys()];
  activeAgentNotifications.clear();
  persistentAgentNotificationId = null;
  speakingAgentAlertTargets = null;
  await Speech.stop().catch(() => undefined);
  await Promise.all(notificationIds.map(identifier => (
    Notifications.dismissNotificationAsync(identifier).catch(() => undefined)
  )));
  await dismissPersistentAgentAlert().catch(() => undefined);
}

export async function dismissAgentAlertsForTab(hostId: string, tabId: string): Promise<void> {
  const targetKey = agentAlertTargetKey(hostId, tabId);
  const notificationIds = [...activeAgentNotifications]
    .filter(([, alert]) => alert.tabTargetKey === targetKey)
    .map(([identifier]) => identifier);
  const pending = pendingTabAlertCounts.has(targetKey);
  if (!pending && notificationIds.length === 0) return;

  tabDismissalGenerations.set(targetKey, (tabDismissalGenerations.get(targetKey) ?? 0) + 1);
  for (const identifier of notificationIds) activeAgentNotifications.delete(identifier);

  if (speakingAgentAlertTargets?.tabTargetKey === targetKey) {
    speakingAgentAlertTargets = null;
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

export async function dismissAgentAlertsForPane(hostId: string, paneId: string): Promise<void> {
  const targetKey = agentAlertTargetKey(hostId, paneId);
  const notificationIds = [...activeAgentNotifications]
    .filter(([, alert]) => alert.paneTargetKey === targetKey)
    .map(([identifier]) => identifier);
  const pending = pendingPaneAlertCounts.has(targetKey);
  if (!pending && notificationIds.length === 0) return;

  paneDismissalGenerations.set(targetKey, (paneDismissalGenerations.get(targetKey) ?? 0) + 1);
  for (const identifier of notificationIds) activeAgentNotifications.delete(identifier);

  if (speakingAgentAlertTargets?.paneTargetKey === targetKey) {
    speakingAgentAlertTargets = null;
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

function agentAlertTargetKey(hostId: string, targetId: string): string {
  return JSON.stringify([hostId, targetId]);
}

function incrementAlertCount(counts: Map<string, number>, targetKey: string): void {
  counts.set(targetKey, (counts.get(targetKey) ?? 0) + 1);
}

function decrementAlertCount(counts: Map<string, number>, targetKey: string): void {
  const remaining = (counts.get(targetKey) ?? 1) - 1;
  if (remaining > 0) counts.set(targetKey, remaining);
  else counts.delete(targetKey);
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
