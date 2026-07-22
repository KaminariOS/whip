import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AboutSection, type AboutSectionProps } from './AboutScreen';
import { SettingsSection, type SettingsSectionProps } from './SettingsScreen';
import { Text } from './ui/text';

interface Props extends SettingsSectionProps, AboutSectionProps {
  connectedHost: string | null;
}

export function MoreScreen(props: Props) {
  const { t } = useTranslation();
  return (
    <ScrollView className="flex-1 bg-background">
      <View className="border-b border-border px-5 py-5">
        <Text className="text-[22px] font-semibold leading-7">{t('nav.more')}</Text>
        <Text className="mt-1 text-sm text-muted-foreground">{props.connectedHost ? t('more.connectedTo', { host: props.connectedHost }) : t('more.noConnection')}</Text>
      </View>
      <SettingsSection
        host={props.host}
        alertsEnabled={props.alertsEnabled}
        ttsEnabled={props.ttsEnabled}
        appearance={props.appearance}
        language={props.language}
        keepScreenOn={props.keepScreenOn}
        reopenTerminalOnLaunch={props.reopenTerminalOnLaunch}
        terminalPreferences={props.terminalPreferences}
        onAlertsChange={props.onAlertsChange}
        onTtsChange={props.onTtsChange}
        onAppearanceChange={props.onAppearanceChange}
        onLanguageChange={props.onLanguageChange}
        onKeepScreenOnChange={props.onKeepScreenOnChange}
        onReopenTerminalOnLaunchChange={props.onReopenTerminalOnLaunchChange}
        onTerminalPreferencesChange={props.onTerminalPreferencesChange}
        onDisconnect={props.onDisconnect}
      />
      <AboutSection server={props.server} />
    </ScrollView>
  );
}
