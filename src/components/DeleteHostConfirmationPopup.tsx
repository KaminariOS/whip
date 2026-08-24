import { Server, Trash2 } from 'lucide-react-native';
import { Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { hostDisplayName } from '../lib/hostProfiles';
import { useTheme } from '../theme';
import type { HostProfile } from '../types';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  busy: boolean;
  host: HostProfile | null;
  onCancel: () => void;
  onDelete: () => void;
}

function sshDestination(host: HostProfile | null): string {
  if (!host) return '';
  const hostname = host.host.includes(':') && !host.host.startsWith('[')
    ? `[${host.host}]`
    : host.host;
  return `${host.username}@${hostname}${host.port === '22' ? '' : `:${host.port}`}`;
}

export function DeleteHostConfirmationPopup({ busy, host, onCancel, onDelete }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={cancel}
      statusBarTranslucent
      transparent
      visible={host !== null}>
      <View className="flex-1 items-center justify-center px-5">
        <Pressable
          accessibilityLabel={t('common.cancel')}
          className="absolute inset-0 bg-black/55"
          disabled={busy}
          onPress={cancel}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="w-full max-w-[380px] rounded-[24px] border border-white/30 p-5 dark:border-white/10">
          <View className="flex-row items-start">
            <View className="size-11 items-center justify-center rounded-full bg-destructive/15">
              <Trash2 color={colors.error} size={22} />
            </View>
            <View className="min-w-0 flex-1 pl-3">
              <Text className="text-[19px] font-bold leading-6">{t('app.deleteHostTitle')}</Text>
              <Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground">
                {t('app.deleteHostCopy', { host: host ? hostDisplayName(host) : '' })}
              </Text>
            </View>
          </View>

          <View className="mt-5 flex-row items-center rounded-xl border border-border bg-muted/40 px-3.5 py-3">
            <Server color={colors.textSecondary} size={17} />
            <Text selectable className="ml-2.5 min-w-0 flex-1 font-mono text-[12px]" numberOfLines={1}>
              {sshDestination(host)}
            </Text>
          </View>

          <View className="mt-5 flex-row gap-2.5">
            <Button
              className="h-12 flex-1 rounded-full"
              disabled={busy}
              variant="secondary"
              onPress={hapticPress(cancel)}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="h-12 flex-1 rounded-full"
              disabled={busy}
              variant="destructive"
              onPress={hapticPress(onDelete)}>
              <Text>{t('common.delete')}</Text>
            </Button>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
