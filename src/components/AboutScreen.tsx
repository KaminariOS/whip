import { Code2, ExternalLink } from 'lucide-react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Alert, Linking, View } from 'react-native';

import { HERDR_PROTOCOL_VERSION } from '@/src/lib/herdrProtocol';
import type { ServerInfo } from '@/src/types';
import { hapticPress, WhipMark } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export const WHIP_GITHUB_URL = 'https://github.com/KaminariOS/whip';

export interface AboutSectionProps {
  server: ServerInfo | null;
}

export function AboutSection({ server }: AboutSectionProps) {
  const whipVersion = Application.nativeApplicationVersion || Constants.expoConfig?.version || 'Unavailable';
  const openGitHub = () => {
    Linking.openURL(WHIP_GITHUB_URL).catch(error => {
      Alert.alert('Could not open GitHub', String(error));
    });
  };

  const connectedVersion = server?.version
    ? `Herdr ${server.version}`
    : server?.running
      ? 'Version unavailable'
      : 'Not connected';
  const connectedProtocol = server?.protocol === undefined ? null : `Protocol ${server.protocol}`;

  return (
    <View className="border-t border-border px-5 pb-11 pt-8">
          <Text className="mb-7 text-[22px] font-semibold leading-7">About</Text>
          <View className="items-center">
            <WhipMark size={82} accessibilityLabel="Whip app icon" />
            <Text className="mt-4 text-[28px] font-semibold leading-9">Whip</Text>
            <Text className="mt-1 text-center text-sm leading-5 text-muted-foreground">Unofficial Android client for Herdr</Text>
            <Text className="mt-1.5 text-center text-xs leading-[17px] text-muted-foreground/70">Version {whipVersion}</Text>
          </View>

          <Text className="mb-3 mt-9 px-1 text-sm font-semibold text-muted-foreground">Compatibility</Text>
          <View className="overflow-hidden rounded-lg border border-border bg-card">
            <AboutRow label="Supported Herdr" value={`Protocol ${HERDR_PROTOCOL_VERSION}`} />
            <AboutRow label="Connected host" value={connectedVersion} detail={connectedProtocol} divided />
          </View>
          <Text className="mt-3 px-1 text-xs leading-[18px] text-muted-foreground">
            Whip works with Herdr releases that report protocol {HERDR_PROTOCOL_VERSION}. Other protocol versions are rejected to prevent incompatible commands.
          </Text>

          <Text className="mb-3 mt-8 px-1 text-sm font-semibold text-muted-foreground">Source</Text>
          <Button
            accessibilityRole="link"
            className="h-auto w-full justify-start rounded-lg border border-border bg-card px-4 py-4"
            variant="outline"
            onPress={hapticPress(openGitHub)}>
            <View className="size-11 items-center justify-center rounded-full bg-accent">
              <Icon as={Code2} size={22} />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-[15px] font-semibold leading-5">GitHub repository</Text>
              <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground" numberOfLines={1}>KaminariOS/whip</Text>
            </View>
            <Icon as={ExternalLink} className="text-muted-foreground" size={19} />
          </Button>
    </View>
  );
}

function AboutRow({ label, value, detail, divided = false }: { label: string; value: string; detail?: string | null; divided?: boolean }) {
  return (
    <View className={divided ? 'min-h-[68px] flex-row items-center border-t border-border px-4 py-3' : 'min-h-[68px] flex-row items-center px-4 py-3'}>
      <Text className="flex-1 text-[15px] font-semibold leading-5">{label}</Text>
      <View className="ml-4 items-end">
        <Text className="text-sm font-medium leading-5">{value}</Text>
        {detail ? <Text className="text-xs leading-[17px] text-muted-foreground">{detail}</Text> : null}
      </View>
    </View>
  );
}
