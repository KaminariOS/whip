import { Camera, Clipboard, FileUp, Image as ImageIcon, Paperclip, X } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import type { AttachmentSource } from '../services/attachmentPaste';
import { hasClipboardAttachment, pickLocalAttachment } from '../services/attachmentPaste';
import type { HerdrClient } from '../services/HerdrClient';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  client: HerdrClient;
  visible: boolean;
  onClose: () => void;
  onPaste: (attachment: PastedAttachment) => void;
}

export interface PastedAttachment {
  remotePath: string;
  previewUri: string | null;
  dispose: () => void;
}

export function AttachmentPasteSheet({ client, visible, onClose, onPaste }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const safeAreaInsets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [clipboardAvailable, setClipboardAvailable] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setClipboardAvailable(false);
    hasClipboardAttachment().then(value => {
      if (active) setClipboardAvailable(value);
    });
    return () => { active = false; };
  }, [visible]);

  const select = async (source: AttachmentSource) => {
    setBusy(true);
    let attachment: Awaited<ReturnType<typeof pickLocalAttachment>> = null;
    try {
      attachment = await pickLocalAttachment(source);
      if (!attachment) return;
      const remotePath = await client.uploadTerminalAttachment(attachment.nativePath);
      onPaste({
        remotePath,
        previewUri: attachment.previewUri,
        dispose: attachment.dispose,
      });
      attachment = null;
      onClose();
    } catch (reason) {
      Alert.alert(t('attachments.failedTitle'), String(reason));
    } finally {
      attachment?.dispose();
      setBusy(false);
    }
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => { if (!busy) onClose(); }}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable accessibilityLabel={t('attachments.close')} className="flex-1" disabled={busy} onPress={onClose} />
        <View className="rounded-t-3xl bg-background px-4 pt-3" style={{ paddingBottom: Math.max(16, safeAreaInsets.bottom) }}>
          <View className="mb-2 flex-row items-center">
            <View className="size-10 items-center justify-center rounded-full bg-muted">
              <Paperclip size={18} color={colors.text} />
            </View>
            <View className="min-w-0 flex-1 px-3">
              <Text className="text-[17px] font-bold text-foreground">{t('attachments.title')}</Text>
              <Text className="text-[11px] text-muted-foreground">{t('attachments.copy')}</Text>
            </View>
            <Button accessibilityLabel={t('attachments.close')} className="size-10 rounded-full px-0" disabled={busy} variant="ghost" onPress={onClose}>
              <X size={19} color={colors.text} />
            </Button>
          </View>
          {busy ? (
            <View className="h-44 items-center justify-center gap-3">
              <ActivityIndicator color={colors.primary} />
              <Text className="text-[12px] text-muted-foreground">{t('attachments.uploading')}</Text>
            </View>
          ) : (
            <View>
              <AttachmentAction icon={<Camera size={19} color={colors.text} />} label={t('attachments.camera')} onPress={() => select('camera')} />
              <AttachmentAction icon={<ImageIcon size={19} color={colors.text} />} label={t('attachments.photo')} onPress={() => select('photo')} />
              <AttachmentAction icon={<FileUp size={19} color={colors.text} />} label={t('attachments.file')} onPress={() => select('file')} />
              {clipboardAvailable && (
                <AttachmentAction icon={<Clipboard size={19} color={colors.text} />} label={t('attachments.clipboard')} onPress={() => select('clipboard')} />
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function AttachmentAction({ icon, label, onPress }: { icon: ReactNode; label: string; onPress: () => void }) {
  return (
    <Button className="h-12 justify-start gap-3 rounded-none border-t border-border px-2" variant="ghost" onPress={hapticPress(onPress)}>
      <View className="size-8 items-center justify-center">{icon}</View>
      <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
    </Button>
  );
}
