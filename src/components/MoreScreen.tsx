import { ScrollView, View } from 'react-native';

import { AboutSection, type AboutSectionProps } from './AboutScreen';
import { SettingsSection, type SettingsSectionProps } from './SettingsScreen';
import { Text } from './ui/text';

interface Props extends SettingsSectionProps, AboutSectionProps {
  connectedHost: string | null;
}

export function MoreScreen(props: Props) {
  return (
    <ScrollView className="flex-1 bg-background">
      <View className="border-b border-border px-5 py-5">
        <Text className="text-[22px] font-semibold leading-7">More</Text>
        <Text className="mt-1 text-sm text-muted-foreground">{props.connectedHost ? `Connected to ${props.connectedHost}` : 'No active connection'}</Text>
      </View>
      <SettingsSection
        host={props.host}
        alertsEnabled={props.alertsEnabled}
        ttsEnabled={props.ttsEnabled}
        appearance={props.appearance}
        keepScreenOn={props.keepScreenOn}
        reopenTerminalOnLaunch={props.reopenTerminalOnLaunch}
        terminalPreferences={props.terminalPreferences}
        onAlertsChange={props.onAlertsChange}
        onTtsChange={props.onTtsChange}
        onAppearanceChange={props.onAppearanceChange}
        onKeepScreenOnChange={props.onKeepScreenOnChange}
        onReopenTerminalOnLaunchChange={props.onReopenTerminalOnLaunchChange}
        onTerminalPreferencesChange={props.onTerminalPreferencesChange}
        onDisconnect={props.onDisconnect}
      />
      <AboutSection server={props.server} />
    </ScrollView>
  );
}
