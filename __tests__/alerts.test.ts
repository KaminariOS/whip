jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
  AndroidNotificationPriority: { MAX: 'max' },
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));
jest.mock('expo-speech', () => ({
  speak: jest.fn(),
  stop: jest.fn(),
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Vibration: { vibrate: jest.fn() },
}));
jest.mock('../src/services/backgroundMonitoring', () => ({
  armPersistentAgentAlert: jest.fn(),
}));
jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: {
    resolvedLanguage: 'en',
    t: (key: string, options?: { name?: string; status?: string }) => {
      if (key === 'alerts.needsYou') return `${options?.name} needs you`;
      if (key === 'alerts.finished') return `${options?.name} finished`;
      if (key === 'alerts.agentState') return `Agent is ${options?.status}`;
      return key;
    },
  },
}));

import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';

import type { AgentInfo } from '../src/types';
import { alertAgent } from '../src/services/alerts';
import { armPersistentAgentAlert } from '../src/services/backgroundMonitoring';

const agent: AgentInfo = {
  terminal_id: 'terminal-1',
  agent: 'codex',
  agent_status: 'blocked',
  workspace_id: 'workspace-1',
  tab_id: 'tab-1',
  pane_id: 'pane-1',
  focused: false,
  revision: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Speech.stop).mockResolvedValue();
  jest.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('notification-1');
  jest.mocked(armPersistentAgentAlert).mockResolvedValue();
});

test('delays the noisy notification and persistent alert until speech finishes', async () => {
  const pending = alertAgent(agent, true, {
    hostId: 'host-1',
    paneId: agent.pane_id,
  }, 'work');
  await Promise.resolve();
  await Promise.resolve();

  expect(Speech.stop).toHaveBeenCalledTimes(1);
  expect(Speech.speak).toHaveBeenCalledTimes(1);
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(armPersistentAgentAlert).not.toHaveBeenCalled();

  const options = jest.mocked(Speech.speak).mock.calls[0][1];
  options?.onDone?.();
  await pending;

  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  expect(armPersistentAgentAlert).toHaveBeenCalledWith(
    'notification-1',
    'agent-state-v3',
    60_000,
  );
});

test('posts the notification immediately when speech is disabled', async () => {
  await alertAgent(agent, false, {
    hostId: 'host-1',
    paneId: agent.pane_id,
  });

  expect(Speech.stop).not.toHaveBeenCalled();
  expect(Speech.speak).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
});

test('still posts the alert when speech reports an error', async () => {
  const pending = alertAgent(agent, true, {
    hostId: 'host-1',
    paneId: agent.pane_id,
  });
  await Promise.resolve();
  await Promise.resolve();

  const options = jest.mocked(Speech.speak).mock.calls[0][1];
  options?.onError?.(new Error('TTS unavailable'));
  await pending;

  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
});
