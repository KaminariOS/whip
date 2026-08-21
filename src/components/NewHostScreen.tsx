import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Check, ChevronLeft, ClipboardPaste, KeyRound, ScanLine, Sparkles, X } from 'lucide-react-native';
import SSHClient from 'react-native-whip-ssh';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Clipboard, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  isWhipPairingCode,
  normalizeEd25519PublicKey,
  type PairHostResult,
  type PairingKeySelection,
} from '@/src/lib/sshPairing';
import { useTheme } from '@/src/theme';
import type { GlobalSshKeyMaterial } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader, WhipMark } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  onCancel: () => void;
  onManual: () => void;
  onLoadGlobalKeys: () => Promise<GlobalSshKeyMaterial[] | null>;
  onPaired: (result: PairHostResult, key: PairingKeySelection) => Promise<void>;
}

export function NewHostScreen({ onCancel, onManual, onLoadGlobalKeys, onPaired }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [selectedKey, setSelectedKey] = useState<PairingKeySelection | null>(null);
  const [globalKeys, setGlobalKeys] = useState<GlobalSshKeyMaterial[] | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanHandled = useRef(false);

  const generateKey = async () => {
    setWorking(true);
    setError(null);
    try {
      const generated = await SSHClient.generateKeyPair('ed25519', '', 256, 'whip');
      const details = await SSHClient.getKeyDetails(generated.privateKey);
      setSelectedKey({
        source: 'generated',
        label: t('pairing.generatedKey'),
        publicKey: generated.publicKey || details.publicKey,
        privateKey: generated.privateKey,
        passphrase: '',
        fingerprint: details.fingerprint,
      });
    } catch (generationError) {
      setError(t('pairing.keyError', { error: String(generationError) }));
    } finally {
      setWorking(false);
    }
  };

  const openGlobalKeys = async () => {
    setWorking(true);
    setError(null);
    try {
      const keys = await onLoadGlobalKeys();
      if (keys === null) return;
      if (keys.length === 0) {
        Alert.alert(t('keychain.emptyTitle'), t('keychain.emptyPickerCopy'));
        return;
      }
      setGlobalKeys(keys);
    } catch (keyError) {
      setError(t('pairing.keyError', { error: String(keyError) }));
    } finally {
      setWorking(false);
    }
  };

  const selectGlobalKey = async (key: GlobalSshKeyMaterial) => {
    setGlobalKeys(null);
    setWorking(true);
    setError(null);
    try {
      const details = await SSHClient.getKeyDetails(key.secret, key.passphrase || undefined);
      setSelectedKey({
        source: 'global',
        label: key.name,
        publicKey: details.publicKey,
        privateKey: key.secret,
        passphrase: key.passphrase,
        fingerprint: details.fingerprint,
      });
    } catch (keyError) {
      setError(t('pairing.keyError', { error: String(keyError) }));
    } finally {
      setWorking(false);
    }
  };

  const pastePublicKey = async () => {
    setError(null);
    try {
      const publicKey = normalizeEd25519PublicKey(await Clipboard.getString());
      if (!publicKey) {
        Alert.alert(t('pairing.invalidPublicKeyTitle'), t('pairing.invalidPublicKeyCopy'));
        return;
      }
      setSelectedKey({
        source: 'clipboard',
        label: t('pairing.clipboardKey'),
        publicKey,
      });
    } catch (pasteError) {
      setError(t('pairing.keyError', { error: String(pasteError) }));
    }
  };

  const launchScanner = async () => {
    if (!selectedKey || working) return;
    setError(null);
    let granted = permission?.granted;
    if (!granted) granted = (await requestPermission()).granted;
    if (!granted) {
      Alert.alert(t('pairing.cameraDeniedTitle'), t('pairing.cameraDeniedCopy'));
      return;
    }
    scanHandled.current = false;
    setScannerOpen(true);
  };

  const handleScan = async ({ data }: BarcodeScanningResult) => {
    if (scanHandled.current || !selectedKey) return;
    scanHandled.current = true;
    if (!isWhipPairingCode(data)) {
      scanHandled.current = false;
      setScannerOpen(false);
      Alert.alert(t('pairing.invalidQrTitle'), t('pairing.invalidQrCopy'));
      return;
    }

    setScannerOpen(false);
    setWorking(true);
    setPairing(true);
    setError(null);
    try {
      const result = await SSHClient.pairHost(data.trim(), selectedKey.publicKey, t('pairing.deviceName'));
      await onPaired(result, selectedKey);
    } catch (pairingError) {
      setError(t('pairing.pairError', { error: String(pairingError) }));
    } finally {
      setPairing(false);
      setWorking(false);
    }
  };

  if (scannerOpen) {
    return (
      <View className="flex-1 bg-black">
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleScan}
        />
        <View className="flex-1 px-5 pb-10 pt-4">
          <View className="flex-row justify-end">
            <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={() => setScannerOpen(false)} />
          </View>
          <View className="flex-1 items-center justify-center">
            <View className="size-64 rounded-[28px] border-2 border-white" />
            <Text className="mt-7 max-w-[300px] text-center text-base font-semibold leading-6 text-white">
              {t('pairing.scanCopy')}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScreenHeader
        title={t('pairing.title')}
        left={<IconButton icon={ChevronLeft} accessibilityLabel={t('connection.back')} onPress={onCancel} />}
      />
      <ScrollView className="flex-1" contentContainerClassName="px-5 pb-8">
        <View className="items-center pb-7 pt-8">
          <WhipMark size={52} />
          <Text className="mt-5 text-center text-2xl font-semibold">{t('pairing.heading')}</Text>
          <Text className="mt-2 max-w-[330px] text-center text-[15px] leading-[22px] text-muted-foreground">
            {t('pairing.intro')}
          </Text>
        </View>

        <Text className="mb-2 text-sm font-semibold text-muted-foreground">{t('pairing.chooseKey')}</Text>
        <View className="overflow-hidden rounded-xl border border-border bg-background">
          <KeyChoice
            icon={Sparkles}
            title={t('pairing.generate')}
            copy={t('pairing.generateCopy')}
            selected={selectedKey?.source === 'generated'}
            disabled={working}
            onPress={generateKey}
          />
          <View className="ml-[68px] h-px bg-border" />
          <KeyChoice
            icon={KeyRound}
            title={t('pairing.globalKey')}
            copy={t('pairing.globalKeyCopy')}
            selected={selectedKey?.source === 'global'}
            disabled={working}
            onPress={openGlobalKeys}
          />
          <View className="ml-[68px] h-px bg-border" />
          <KeyChoice
            icon={ClipboardPaste}
            title={t('pairing.clipboard')}
            copy={t('pairing.clipboardCopy')}
            selected={selectedKey?.source === 'clipboard'}
            disabled={working}
            onPress={pastePublicKey}
          />
        </View>

        {selectedKey ? (
          <View className="mt-4 flex-row items-start gap-3 rounded-lg bg-muted px-4 py-3">
            <Icon as={Check} className="mt-0.5 text-primary" size={17} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold" numberOfLines={1}>{selectedKey.label}</Text>
              <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground" numberOfLines={2}>
                {selectedKey.fingerprint || t('pairing.publicOnlyWarning')}
              </Text>
            </View>
          </View>
        ) : null}

        {error ? <Text accessibilityLiveRegion="polite" className="mt-4 text-sm leading-5 text-destructive">{error}</Text> : null}

        <Button className="mt-7 h-12 rounded-full" disabled={!selectedKey || working} onPress={hapticPress(launchScanner)}>
          {working ? <ActivityIndicator color={colors.onPrimary} /> : <Icon as={ScanLine} className="text-primary-foreground" size={19} />}
          <Text>{pairing ? t('pairing.waiting') : t('pairing.scan')}</Text>
        </Button>
        <Button className="mt-2" variant="ghost" disabled={working} onPress={onManual}>
          <Text>{t('pairing.manual')}</Text>
        </Button>
      </ScrollView>

      <Modal transparent animationType="fade" visible={globalKeys !== null} onRequestClose={() => setGlobalKeys(null)}>
        <Pressable className="flex-1 justify-end bg-black/45" onPress={() => setGlobalKeys(null)}>
          <Pressable className="max-h-[70%] rounded-t-[24px] bg-background px-5 pb-8 pt-4" onPress={event => event.stopPropagation()}>
            <View className="mb-4 h-1 w-10 self-center rounded-full bg-muted-foreground/30" />
            <Text className="text-xl font-semibold">{t('pairing.chooseGlobalKey')}</Text>
            <ScrollView className="mt-3">
              {globalKeys?.map(key => (
                <Button key={key.id} size="content" variant="ghost" className="h-auto w-full justify-start gap-3 border-b border-border px-1 py-4" onPress={() => selectGlobalKey(key)}>
                  <View className="size-10 items-center justify-center rounded-full bg-primary/10"><Icon as={KeyRound} className="text-primary" size={18} /></View>
                  <View className="min-w-0 flex-1 items-start"><Text className="font-semibold" numberOfLines={1}>{key.name}</Text><Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>{key.fingerprint}</Text></View>
                </Button>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function KeyChoice({ icon, title, copy, selected, disabled, onPress }: {
  icon: typeof KeyRound;
  title: string;
  copy: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button size="content" variant="ghost" className="h-auto min-h-[78px] w-full justify-start gap-3 rounded-none px-4 py-3" disabled={disabled} onPress={hapticPress(onPress)}>
      <View className="size-10 items-center justify-center rounded-full bg-primary/10"><Icon as={icon} className="text-primary" size={18} /></View>
      <View className="min-w-0 flex-1 items-start"><Text className="text-[15px] font-semibold">{title}</Text><Text className="mt-0.5 text-left text-xs leading-[17px] text-muted-foreground">{copy}</Text></View>
      {selected ? <Icon as={Check} className="text-primary" size={19} /> : null}
    </Button>
  );
}
