import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { ChevronLeft, Keyboard, ScanLine, X } from 'lucide-react-native';
import SSHClient from 'react-native-whip-ssh';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  isWhipPairingCode,
  publicKeyVerificationCode,
  type PairHostResult,
  type PairingKeySelection,
} from '@/src/lib/sshPairing';
import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, useTheme } from '@/src/theme';
import type { GlobalSshKeyMaterial } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader, WhipMark } from './app-ui';
import { GlassBackdrop, GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  onCancel: () => void;
  onManual: () => void;
  onLoadGlobalKeys: () => Promise<GlobalSshKeyMaterial[] | null>;
  onPaired: (result: PairHostResult, key: PairingKeySelection) => Promise<void>;
}

export function NewHostScreen({ onCancel, onManual, onPaired }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const [permission, requestPermission] = useCameraPermissions();
  const [selectedKey, setSelectedKey] = useState<PairingKeySelection | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [verificationCode, setVerificationCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scanHandled = useRef(false);

  const launchScanner = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      let granted = permission?.granted;
      if (!granted) granted = (await requestPermission()).granted;
      if (!granted) {
        Alert.alert(t('pairing.cameraDeniedTitle'), t('pairing.cameraDeniedCopy'));
        return;
      }

      const generated = await SSHClient.generateKeyPair('ed25519', '', 256, 'whip');
      const details = await SSHClient.getKeyDetails(generated.privateKey);
      const publicKey = generated.publicKey || details.publicKey;
      setVerificationCode(await publicKeyVerificationCode(publicKey));
      setSelectedKey({
        source: 'generated',
        label: t('pairing.generatedKey'),
        publicKey,
        privateKey: generated.privateKey,
        passphrase: '',
        fingerprint: details.fingerprint,
      });
      scanHandled.current = false;
      setScannerOpen(true);
    } catch (generationError) {
      setError(t('pairing.keyError', { error: String(generationError) }));
    } finally {
      setWorking(false);
    }
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

        <GlassSurface className="mb-6 rounded-xl border border-white/30 px-4 py-3 dark:border-white/10">
          <Text className="text-sm font-semibold">{t('pairing.runOnHost')}</Text>
          <View className="mt-2 gap-2">
            <Text
              selectable
              className={cn('rounded-lg border px-3 py-2 font-mono text-sm', !appGlassEnabled && 'border-border bg-background')}
              style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}>
              {'uvx whipair'}
            </Text>
            <Text
              selectable
              className={cn('rounded-lg border px-3 py-2 font-mono text-sm', !appGlassEnabled && 'border-border bg-background')}
              style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}>
              {'npx whipair'}
            </Text>
          </View>
        </GlassSurface>

        {error ? <Text accessibilityLiveRegion="polite" className="mt-4 text-sm leading-5 text-destructive">{error}</Text> : null}

        {pairing && verificationCode ? (
          <Text accessibilityLiveRegion="polite" className="mt-6 text-center font-mono text-2xl font-semibold tracking-wider">
            {t('pairing.verify', { code: verificationCode })}
          </Text>
        ) : null}

        <Button className={cn(pairing && verificationCode ? 'mt-4' : 'mt-7', 'h-12 rounded-full')} disabled={working} onPress={hapticPress(launchScanner)}>
          {working ? <ActivityIndicator color={colors.onPrimary} /> : <Icon as={ScanLine} className="text-primary-foreground" size={19} />}
          <Text>{pairing ? t('pairing.waiting') : t('pairing.scan')}</Text>
        </Button>
        <Button
          className={cn('relative mt-3 h-12 overflow-hidden rounded-full', appGlassEnabled && 'border')}
          style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
          variant={appGlassEnabled ? 'ghost' : 'outline'}
          disabled={working}
          onPress={hapticPress(onManual)}>
          <GlassBackdrop shapeClassName="rounded-full" />
          <Icon as={Keyboard} size={19} />
          <Text>{t('pairing.manual')}</Text>
        </Button>
      </ScrollView>

    </View>
  );
}
