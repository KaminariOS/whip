import { Modal, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { WhipMark } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  authenticating: boolean;
  visible: boolean;
  onRetry: () => void;
}

export function AppAccessLock({ authenticating, visible, onRetry }: Props) {
  const { t } = useTranslation();
  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={onRetry}
      statusBarTranslucent
      visible={visible}
    >
      <View className="flex-1 items-center justify-center bg-background px-8">
        <WhipMark accessibilityLabel={t('app.biometricLocked')} size={64} />
        <Text className="mt-6 text-center text-[22px] font-semibold leading-7">{t('app.biometricLocked')}</Text>
        <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{t('app.biometricLockedCopy')}</Text>
        {!authenticating ? (
          <Button className="mt-6 rounded-full px-6" onPress={onRetry}>
            <Text>{t('app.biometricRetry')}</Text>
          </Button>
        ) : null}
      </View>
    </Modal>
  );
}
