import { SquareTerminal, TriangleAlert } from 'lucide-react-native';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import type { CodexIntegrationStatus } from '../lib/codexSession';
import { useTheme } from '../theme';
import { AgentBrandIcon } from './AgentBrandIcon';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

type InstallableCodexIntegrationStatus = Extract<
  CodexIntegrationStatus,
  'not-installed' | 'outdated' | 'needs-repair'
>;

interface Props {
  onCancel: () => void;
  onInstall: () => void;
  status: InstallableCodexIntegrationStatus | null;
}

function promptCopy(status: InstallableCodexIntegrationStatus | null): {
  explanation: string;
  title: string;
} {
  if (status === 'outdated') {
    return {
      explanation: 'The installed Herdr Codex integration is outdated.',
      title: 'Update Herdr Codex integration?',
    };
  }
  if (status === 'needs-repair') {
    return {
      explanation: 'The installed Herdr Codex integration needs repair.',
      title: 'Repair Herdr Codex integration?',
    };
  }
  return {
    explanation: 'Whip needs Herdr\u2019s native Codex session identity.',
    title: 'Install Herdr Codex integration?',
  };
}

export function CodexIntegrationInstallSheet({ onCancel, onInstall, status }: Props) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const copy = promptCopy(status);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
      transparent
      visible={status !== null}>
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel={t('common.cancel')}
          className="absolute inset-0 bg-black/55"
          onPress={onCancel}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="rounded-t-[28px] border-t border-white/30 px-4 pt-5 dark:border-white/10"
          style={{ paddingBottom: Math.max(16, bottom) }}>
          <View className="flex-row items-start px-1">
            <View className="size-11 items-center justify-center rounded-full bg-primary/15">
              <AgentBrandIcon agent="codex" color={colors.primary} size={22} />
            </View>
            <View className="min-w-0 flex-1 pl-3">
              <Text className="text-[19px] font-bold leading-6">{copy.title}</Text>
              <Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground">
                {copy.explanation}
              </Text>
            </View>
          </View>

          <View className="mt-5 flex-row items-center rounded-xl border border-border bg-muted/40 px-3.5 py-3">
            <SquareTerminal color={colors.textSecondary} size={17} />
            <Text selectable className="ml-2.5 min-w-0 flex-1 font-mono text-[12px]">
              herdr integration install codex
            </Text>
          </View>

          <View className="mt-3 flex-row items-start rounded-xl bg-primary/10 px-3.5 py-3">
            <TriangleAlert color={colors.primary} size={17} />
            <Text className="min-w-0 flex-1 pl-2.5 text-[12px] leading-[17px] text-muted-foreground">
              This changes the integration for your user on the remote host. The running Codex process may need to be restarted before Chat is available.
            </Text>
          </View>

          <View className="mt-5 flex-row gap-2.5">
            <Button
              className="h-12 flex-1 rounded-full"
              variant="secondary"
              onPress={hapticPress(onCancel)}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="h-12 flex-1 rounded-full"
              onPress={hapticPress(onInstall)}>
              <Text>Install</Text>
            </Button>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
