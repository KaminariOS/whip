import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';

import { dismissAgentAlerts, prepareAlerts } from '../services/alerts';

/** Owns notification setup, response delivery, and foreground cleanup. */
export function useAgentNotifications() {
  const [response, setResponse] =
    useState<Notifications.NotificationResponse | null>(null);
  const handledNotificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    prepareAlerts().catch(() => undefined);
    let active = true;
    let receivedResponse = false;
    const subscription = Notifications.addNotificationResponseReceivedListener(
      value => {
        receivedResponse = true;
        setResponse(value);
      },
    );
    Notifications.getLastNotificationResponseAsync()
      .then(value => {
        if (active && !receivedResponse && value) setResponse(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const returnedToForeground =
        previousState !== 'active' && state === 'active';
      previousState = state;
      if (returnedToForeground) dismissAgentAlerts().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  const wasHandled = useCallback(
    (notificationId: string) =>
      handledNotificationIdRef.current === notificationId,
    [],
  );

  const consume = useCallback((notificationId: string) => {
    handledNotificationIdRef.current = notificationId;
    Notifications.clearLastNotificationResponse();
    setResponse(null);
  }, []);

  return { response, wasHandled, consume };
}
