import { ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AboutSection } from './AboutScreen';
import { AppLogsSection } from './AppLogsScreen';
import { SettingsDetailsProvider, SettingsSection, type SettingsSectionProps } from './SettingsScreen';
import { GlassSurface } from './GlassSurface';
import { Text } from './ui/text';

type Props = SettingsSectionProps;

export function MoreScreen(props: Props) {
  const { t } = useTranslation();
  return (
    <SettingsDetailsProvider>
      <ScrollView className="flex-1">
        <GlassSurface className="border-b border-white/30 px-5 py-5 dark:border-white/10">
          <Text className="text-[22px] font-semibold leading-7">{t('nav.more')}</Text>
        </GlassSurface>
        <AboutSection />
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
        sshQrPairingEnabled={props.sshQrPairingEnabled}
        language={props.language}
        keepScreenOn={props.keepScreenOn}
        reopenTerminalOnLaunch={props.reopenTerminalOnLaunch}
        agentCommand={props.agentCommand}
        terminalHistory={props.terminalHistory}
        terminalPreferences={props.terminalPreferences}
        onAlertsChange={props.onAlertsChange}
        onPersistentAlertDurationChange={props.onPersistentAlertDurationChange}
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
        onSshQrPairingEnabledChange={props.onSshQrPairingEnabledChange}
        onLanguageChange={props.onLanguageChange}
        onKeepScreenOnChange={props.onKeepScreenOnChange}
        onReopenTerminalOnLaunchChange={props.onReopenTerminalOnLaunchChange}
        onAgentCommandChange={props.onAgentCommandChange}
        onDeleteTerminalHistory={props.onDeleteTerminalHistory}
        onTerminalPreferencesChange={props.onTerminalPreferencesChange}
        />
        <AppLogsSection />
      </ScrollView>
    </SettingsDetailsProvider>
  );
}
