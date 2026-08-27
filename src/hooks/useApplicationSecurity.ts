import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

import { biometricResumeAction } from '../lib/appAccess';
import { authenticateAppAccess } from '../services/appAuthentication';

interface ApplicationSecurityOptions {
  preferencesLoaded: boolean;
  biometricForKeys: boolean;
  biometricOnResume: boolean;
  onBiometricForKeysChange: (enabled: boolean) => void;
  onBiometricOnResumeChange: (enabled: boolean) => void;
  biometricUnavailableTitle: string;
  biometricUnavailableMessage: (error: unknown) => string;
}

/** Owns foreground locking, biometric serialization, and unlock state. */
export function useApplicationSecurity(options: ApplicationSecurityOptions) {
  const {
    preferencesLoaded,
    biometricForKeys,
    biometricOnResume,
    onBiometricForKeysChange,
    onBiometricOnResumeChange,
    biometricUnavailableTitle,
    biometricUnavailableMessage,
  } = options;
  const [locked, setLocked] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const authenticationInFlightRef = useRef(false);
  const settingChangeInFlightRef = useRef(false);
  const preferencesLoadedRef = useRef(preferencesLoaded);
  const biometricForKeysRef = useRef(biometricForKeys);
  const biometricOnResumeRef = useRef(biometricOnResume);
  preferencesLoadedRef.current = preferencesLoaded;
  biometricForKeysRef.current = biometricForKeys;
  biometricOnResumeRef.current = biometricOnResume;

  const authenticateLockedApp = useCallback(async () => {
    if (authenticationInFlightRef.current) return;
    authenticationInFlightRef.current = true;
    setAuthenticating(true);
    try {
      await authenticateAppAccess();
      setLocked(false);
    } catch {
      // Cancellation and failed checks leave the app locked for an explicit retry.
    } finally {
      authenticationInFlightRef.current = false;
      setAuthenticating(false);
    }
  }, []);

  const verifyBiometric = useCallback(async (): Promise<boolean> => {
    try {
      await authenticateAppAccess();
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'E_APP_AUTH_CANCELLED') {
        Alert.alert(
          biometricUnavailableTitle,
          biometricUnavailableMessage(error),
        );
      }
      return false;
    }
  }, [biometricUnavailableMessage, biometricUnavailableTitle]);

  const updateSecuritySetting = useCallback(
    async (apply: () => void) => {
      if (settingChangeInFlightRef.current) return;
      settingChangeInFlightRef.current = true;
      try {
        if (await verifyBiometric()) apply();
      } finally {
        settingChangeInFlightRef.current = false;
      }
    },
    [verifyBiometric],
  );

  const updateBiometricForKeys = useCallback(
    async (enabled: boolean) => {
      await updateSecuritySetting(() => onBiometricForKeysChange(enabled));
    },
    [onBiometricForKeysChange, updateSecuritySetting],
  );

  const updateBiometricOnResume = useCallback(
    async (enabled: boolean) => {
      await updateSecuritySetting(() => {
        onBiometricOnResumeChange(enabled);
        if (!enabled) setLocked(false);
      });
    },
    [onBiometricOnResumeChange, updateSecuritySetting],
  );

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const action = biometricResumeAction(
        previousState,
        state,
        biometricOnResumeRef.current,
        preferencesLoadedRef.current,
      );
      previousState = state;
      if (action === 'lock') {
        setLocked(true);
      } else if (action === 'authenticate') {
        setLocked(true);
        authenticateLockedApp();
      }
    });
    return () => subscription.remove();
  }, [authenticateLockedApp]);

  const isKeyProtectionEnabled = useCallback(
    () => biometricForKeysRef.current,
    [],
  );

  return useMemo(
    () => ({
      locked,
      authenticating,
      authenticateLockedApp,
      verifyBiometric,
      updateBiometricForKeys,
      updateBiometricOnResume,
      isKeyProtectionEnabled,
    }),
    [
      authenticateLockedApp,
      authenticating,
      isKeyProtectionEnabled,
      locked,
      updateBiometricForKeys,
      updateBiometricOnResume,
      verifyBiometric,
    ],
  );
}
