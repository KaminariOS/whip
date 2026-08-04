import { ChevronDown, ChevronUp, Code2, ExternalLink, Share2 } from 'lucide-react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { useState } from 'react';
import { Alert, Linking, Share, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import terminalFonts from '@/assets/terminal-fonts/manifest.json';
import { HERDR_PROTOCOL_VERSIONS_LABEL } from '@/src/lib/herdrProtocol';
import type { ServerInfo } from '@/src/types';
import { hapticPress, WhipMark } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export const WHIP_RELEASES_URL = 'https://github.com/KaminariOS/whip/releases';

export interface AboutSectionProps {
  server: ServerInfo | null;
}

export function AboutSection({ server }: AboutSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();
  const whipVersion = Application.nativeApplicationVersion || Constants.expoConfig?.version || t('common.unavailable');
  const openReleases = () => {
    Linking.openURL(WHIP_RELEASES_URL).catch(error => {
      Alert.alert(t('about.githubError'), String(error));
    });
  };
  const shareReleases = () => {
    Share.share({
      title: t('about.shareTitle'),
      message: t('about.shareMessage', { url: WHIP_RELEASES_URL }),
    }).catch(error => {
      Alert.alert(t('about.shareError'), String(error));
    });
  };

  const connectedVersion = server?.version
    ? `Herdr ${server.version}`
    : server?.running
      ? t('about.versionUnavailable')
      : t('common.notConnected');
  const connectedProtocol = server?.protocol === undefined ? null : t('common.protocol', { version: server.protocol });

  return (
    <View className="border-t border-border px-4 py-5">
      <Button
        accessibilityLabel={expanded ? t('about.collapse') : t('about.expand')}
        accessibilityState={{ expanded }}
        className="min-h-[72px] w-full justify-start rounded-lg border border-border bg-card px-4 py-3"
        size="content"
        variant="ghost"
        onPress={hapticPress(() => setExpanded(value => !value))}>
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] font-semibold leading-6">{t('about.title')}</Text>
          <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('about.copy')}</Text>
        </View>
        <Icon as={expanded ? ChevronUp : ChevronDown} className="text-muted-foreground" size={21} />
      </Button>
      {expanded ? (
        <View className="pb-6 pt-7">
          <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{t('about.source')}</Text>
          <View className="flex-row gap-2.5">
            <Button
              accessibilityRole="link"
              className="h-auto min-w-0 flex-1 justify-start rounded-lg border border-border bg-card px-4 py-4"
              variant="outline"
              onPress={hapticPress(openReleases)}>
              <View className="size-11 items-center justify-center rounded-full bg-accent">
                <Icon as={Code2} size={22} />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] font-semibold leading-5">{t('about.githubRepository')}</Text>
                <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground" numberOfLines={1}>KaminariOS/whip</Text>
              </View>
              <Icon as={ExternalLink} className="text-muted-foreground" size={19} />
            </Button>
            <Button
              accessibilityLabel={t('about.shareReleases')}
              className="w-14 self-stretch rounded-lg border border-border bg-card px-0"
              size="content"
              variant="outline"
              onPress={hapticPress(shareReleases)}>
              <Icon as={Share2} size={21} />
            </Button>
          </View>

          <View className="mt-9 items-center">
            <WhipMark size={82} accessibilityLabel={t('about.appIcon')} />
            <Text className="mt-4 text-[28px] font-semibold leading-9">Whip</Text>
            <Text className="mt-1 text-center text-sm leading-5 text-muted-foreground">{t('about.tagline')}</Text>
            <Text className="mt-1.5 text-center text-xs leading-[17px] text-muted-foreground/70">{t('common.version', { version: whipVersion })}</Text>
          </View>

          <Text className="mb-3 mt-9 px-1 text-sm font-semibold text-muted-foreground">{t('about.compatibility')}</Text>
          <View className="overflow-hidden rounded-lg border border-border bg-card">
            <AboutRow label={t('about.supportedHerdr')} value={t('common.protocol', { version: HERDR_PROTOCOL_VERSIONS_LABEL })} />
            <AboutRow label={t('about.connectedHost')} value={connectedVersion} detail={connectedProtocol} divided />
          </View>
          <Text className="mt-3 px-1 text-xs leading-[18px] text-muted-foreground">
            {t('about.compatibilityCopy', { versions: HERDR_PROTOCOL_VERSIONS_LABEL })}
          </Text>

          <Text className="mb-3 mt-8 px-1 text-sm font-semibold text-muted-foreground">{t('about.terminalFonts')}</Text>
          <View className="overflow-hidden rounded-lg border border-border bg-card">
            <AboutRow label={t('about.terminalTextFont')} value={terminalFonts.text.displayName} />
            <AboutRow label={t('about.terminalCjkFont')} value={terminalFonts.cjk.displayName} divided />
            <AboutRow label={t('about.terminalSymbolFont')} value={terminalFonts.symbols.displayName} divided />
            <AboutRow label={t('about.terminalEmojiFont')} value={terminalFonts.emoji.displayName} divided />
            <AboutRow label={t('about.terminalFallbackFont')} value={terminalFonts.fallback.displayName} divided />
          </View>

        </View>
      ) : null}
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
