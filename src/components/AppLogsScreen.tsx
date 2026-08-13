import { Check, ChevronRight, Copy, FileText, X } from 'lucide-react-native';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Clipboard, Modal, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import {
  formatAppLogs,
  getAppLogEntries,
  subscribeToAppLogs,
  type AppLogLevel,
} from '@/src/services/appLogs';
import { hapticPress, IconButton } from './app-ui';
import { GlassBackdrop, GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

const levelTextClasses: Record<AppLogLevel, string> = {
  debug: 'text-terminal-subtle',
  info: 'text-terminal-accent',
  log: 'text-terminal-text',
  warn: 'text-terminal-warning',
  error: 'text-terminal-error',
};

export function AppLogsSection() {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();

  return (
    <View className="border-t border-border px-4 py-5">
      <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">
        {t('appLogs.diagnostics')}
      </Text>
      <Button
        accessibilityLabel={t('appLogs.open')}
        className="min-h-[72px] w-full justify-start overflow-hidden rounded-lg border border-white/30 bg-transparent px-4 py-3 dark:border-white/10"
        size="content"
        variant="ghost"
        onPress={hapticPress(() => setVisible(true))}
      >
        <GlassBackdrop />
        <View className="size-10 items-center justify-center rounded-full bg-accent">
          <Icon as={FileText} size={20} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] font-semibold leading-6">
            {t('appLogs.title')}
          </Text>
          <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">
            {t('appLogs.copy')}
          </Text>
        </View>
        <Icon as={ChevronRight} className="text-muted-foreground" size={20} />
      </Button>
      <AppLogsModal visible={visible} onClose={() => setVisible(false)} />
    </View>
  );
}

function AppLogsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const entries = useSyncExternalStore(
    subscribeToAppLogs,
    getAppLogEntries,
    getAppLogEntries,
  );
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const scrollToLatest = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (visible) scrollToLatest.current = true;
    else setCopied(false);
  }, [visible]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyLogs = () => {
    Clipboard.setString(formatAppLogs(entries));
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      visible={visible}
      onRequestClose={onClose}
    >
      <SafeAreaView className="flex-1 bg-background">
        <GlassSurface className="border-b border-white/30 px-3 py-2 dark:border-white/10">
          <View className="flex-row items-center">
            <IconButton
              icon={X}
              accessibilityLabel={t('common.close')}
              onPress={onClose}
            />
            <View className="ml-1 min-w-0 flex-1">
              <Text className="text-[20px] font-semibold leading-6">
                {t('appLogs.title')}
              </Text>
              <Text className="text-xs leading-[17px] text-muted-foreground">
                {t('appLogs.entryCount', { count: entries.length })}
              </Text>
            </View>
            <Button
              accessibilityLabel={
                copied ? t('appLogs.copied') : t('appLogs.copyAll')
              }
              className="rounded-full px-3"
              size="sm"
              variant={copied ? 'secondary' : 'default'}
              onPress={hapticPress(copyLogs)}
            >
              <Icon as={copied ? Check : Copy} size={16} />
              <Text>{copied ? t('appLogs.copied') : t('appLogs.copyAll')}</Text>
            </Button>
          </View>
        </GlassSurface>

        <View className="flex-1 px-4 pb-4 pt-3">
          <View className="mb-3 flex-row items-start gap-2 px-1">
            <Icon
              as={FileText}
              className="mt-0.5 text-muted-foreground"
              size={15}
            />
            <Text className="min-w-0 flex-1 text-xs leading-[18px] text-muted-foreground">
              {t('appLogs.privacy')}
            </Text>
          </View>
          <View className="flex-1 overflow-hidden rounded-lg border border-terminal-divider bg-terminal-canvas">
            <ScrollView
              ref={scrollRef}
              className="flex-1"
              contentContainerClassName="p-3"
              onContentSizeChange={() => {
                if (!scrollToLatest.current) return;
                scrollToLatest.current = false;
                scrollRef.current?.scrollToEnd({ animated: false });
              }}
            >
              {entries.map(entry => (
                <View key={entry.id} className="mb-2 flex-row items-start">
                  <Text
                    selectable
                    className="w-[88px] font-mono text-[10px] leading-[15px] text-terminal-subtle"
                  >
                    {entry.timestamp.slice(11, 23)}
                  </Text>
                  <Text
                    selectable
                    className={`w-[42px] font-mono text-[10px] font-semibold leading-[15px] ${
                      levelTextClasses[entry.level]
                    }`}
                  >
                    {entry.level.toUpperCase()}
                  </Text>
                  <Text
                    selectable
                    className="min-w-0 flex-1 font-mono text-[11px] leading-[16px] text-terminal-text"
                  >
                    {entry.message}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
          <Text
            accessibilityLiveRegion="polite"
            className="mt-2 min-h-5 text-center text-xs font-medium text-primary"
          >
            {copied ? t('appLogs.copyConfirmation') : ' '}
          </Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
