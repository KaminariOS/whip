import { Alert, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AboutSection } from './AboutScreen';
import { AppLogsSection } from './AppLogsScreen';
import { FeedbackSection } from './FeedbackSection';
import {
  SettingsDetailsProvider,
  SettingsSection,
  type SettingsSectionProps,
} from './SettingsScreen';
import { GlassSurface } from './GlassSurface';
import { Text } from './ui/text';
import { hasCapability } from '../billing/capabilities';
import type { WhipTier } from '../billing/tiers';
import type { WhipEntitlementsController } from '../billing/useWhipEntitlements';
import { MembershipSection } from './MembershipSection';

type Props = Omit<
  SettingsSectionProps,
  | 'customAppBackgroundUnlocked'
  | 'customTerminalBackgroundUnlocked'
  | 'glassUnlocked'
  | 'onOpenRancher'
> & {
  accessTier: WhipTier;
  entitlements: WhipEntitlementsController;
  onOpenLicenses: () => void;
};

export function MoreScreen(props: Props) {
  const { t } = useTranslation();
  const openRancher = async () => {
    if (!props.rancherPaymentsEnabled) return;
    try {
      await props.entitlements.presentRancherPaywall();
    } catch (error) {
      Alert.alert(t('membership.errorTitle'), String(error));
    }
  };
  return (
    <SettingsDetailsProvider>
      <ScrollView className="flex-1">
        <GlassSurface className="border-b border-white/30 px-5 py-5 dark:border-white/10">
          <Text className="text-[22px] font-semibold leading-7">
            {t('nav.more')}
          </Text>
        </GlassSurface>
        {props.rancherPaymentsEnabled ? (
          <MembershipSection entitlements={props.entitlements} />
        ) : null}
        <AboutSection onOpenLicenses={props.onOpenLicenses} />
        {props.developerOptionsEnabled ? <FeedbackSection /> : null}
        <SettingsSection
          alertsEnabled={props.alertsEnabled}
          persistentAlertDurationSeconds={props.persistentAlertDurationSeconds}
          ttsEnabled={props.ttsEnabled}
          biometricForKeys={props.biometricForKeys}
          biometricOnResume={props.biometricOnResume}
          globalKeyCount={props.globalKeyCount}
          knownHostCount={props.knownHostCount}
          appearance={props.appearance}
          fullscreenApp={props.fullscreenApp}
          appBackgroundImageUri={props.appBackgroundImageUri}
          appBackgroundDimming={props.appBackgroundDimming}
          appGlassEnabled={props.appGlassEnabled}
          customAppBackgroundUnlocked={hasCapability(
            props.accessTier,
            'custom-app-background',
          )}
          customTerminalBackgroundUnlocked={hasCapability(
            props.accessTier,
            'custom-terminal-background',
          )}
          glassUnlocked={hasCapability(props.accessTier, 'glass')}
          onOpenRancher={openRancher}
          developerOptionsEnabled={props.developerOptionsEnabled}
          language={props.language}
          keepScreenOn={props.keepScreenOn}
          reopenTerminalOnLaunch={props.reopenTerminalOnLaunch}
          agentCommand={props.agentCommand}
          terminalHistory={props.terminalHistory}
          terminalPreferences={props.terminalPreferences}
          onAlertsChange={props.onAlertsChange}
          onPersistentAlertDurationChange={
            props.onPersistentAlertDurationChange
          }
          onTestPersistentAlert={props.onTestPersistentAlert}
          onTtsChange={props.onTtsChange}
          onBiometricForKeysChange={props.onBiometricForKeysChange}
          onBiometricOnResumeChange={props.onBiometricOnResumeChange}
          onManageGlobalKeychain={props.onManageGlobalKeychain}
          onManageKnownHosts={props.onManageKnownHosts}
          onAppearanceChange={props.onAppearanceChange}
          onFullscreenAppChange={props.onFullscreenAppChange}
          onAppBackgroundImageChange={props.onAppBackgroundImageChange}
          onAppBackgroundDimmingChange={props.onAppBackgroundDimmingChange}
          onAppGlassEnabledChange={props.onAppGlassEnabledChange}
          onDeveloperOptionsEnabledChange={
            props.onDeveloperOptionsEnabledChange
          }
          rancherPaymentsEnabled={props.rancherPaymentsEnabled}
          onRancherPaymentsEnabledChange={
            props.onRancherPaymentsEnabledChange
          }
          onLanguageChange={props.onLanguageChange}
          onKeepScreenOnChange={props.onKeepScreenOnChange}
          onReopenTerminalOnLaunchChange={props.onReopenTerminalOnLaunchChange}
          onAgentCommandChange={props.onAgentCommandChange}
          onDeleteTerminalHistory={props.onDeleteTerminalHistory}
          onTerminalPreferencesChange={props.onTerminalPreferencesChange}
        />
        {props.developerOptionsEnabled ? <AppLogsSection /> : null}
      </ScrollView>
    </SettingsDetailsProvider>
  );
}
