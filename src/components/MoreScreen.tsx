import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AboutSection, type AboutSectionProps } from './AboutScreen';
import { SettingsSection, type SettingsSectionProps } from './SettingsScreen';
import { Text } from './ui/text';

type Props = SettingsSectionProps & AboutSectionProps;

export function MoreScreen(props: Props) {
  const { t } = useTranslation();
  return (
    <ScrollView className="flex-1 bg-background">
      <View className="border-b border-border px-5 py-5">
        <Text className="text-[22px] font-semibold leading-7">{t('nav.more')}</Text>
      </View>
      <AboutSection server={props.server} />
      <SettingsSection
        alertsEnabled={props.alertsEnabled}
        ttsEnabled={props.ttsEnabled}
        biometricForKeys={props.biometricForKeys}
        biometricOnResume={props.biometricOnResume}
        globalKeyCount={props.globalKeyCount}
        knownHostCount={props.knownHostCount}
        appearance={props.appearance}
        language={props.language}
        keepScreenOn={props.keepScreenOn}
        reopenTerminalOnLaunch={props.reopenTerminalOnLaunch}
        agentCommand={props.agentCommand}
        terminalPreferences={props.terminalPreferences}
        onAlertsChange={props.onAlertsChange}
        onTtsChange={props.onTtsChange}
        onBiometricForKeysChange={props.onBiometricForKeysChange}
        onBiometricOnResumeChange={props.onBiometricOnResumeChange}
        onManageGlobalKeychain={props.onManageGlobalKeychain}
        onManageKnownHosts={props.onManageKnownHosts}
        onAppearanceChange={props.onAppearanceChange}
        onLanguageChange={props.onLanguageChange}
        onKeepScreenOnChange={props.onKeepScreenOnChange}
        onReopenTerminalOnLaunchChange={props.onReopenTerminalOnLaunchChange}
        onAgentCommandChange={props.onAgentCommandChange}
        onTerminalPreferencesChange={props.onTerminalPreferencesChange}
      />
    </ScrollView>
  );
}
