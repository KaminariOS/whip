import SSHClient from '@dylankenneally/react-native-ssh-sftp';
import { ChevronLeft, ClipboardPaste, FileUp, KeyRound, Plus, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Clipboard, NativeModules, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { normalizePrivateKey } from '@/src/lib/privateKey';
import { deleteGlobalSshKey, saveGlobalSshKey } from '@/src/services/globalSshKeychain';
import type { GlobalSshKeyMaterial } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  initialKeys: GlobalSshKeyMaterial[];
  onClose: () => void;
  onChanged: (keys: GlobalSshKeyMaterial[]) => void;
}

type PrivateKeyFilePickerModule = {
  pickPrivateKey(): Promise<string | null>;
};

const privateKeyFilePicker = NativeModules.PrivateKeyFilePicker as PrivateKeyFilePickerModule | undefined;

export function GlobalKeychainScreen({ initialKeys, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState(initialKeys);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');

  useEffect(() => { setKeys(initialKeys); }, [initialKeys]);

  const updateKeys = (next: GlobalSshKeyMaterial[]) => {
    setKeys(next);
    onChanged(next);
  };
  const resetDraft = () => {
    setName('');
    setPrivateKey('');
    setPassphrase('');
    setAdding(false);
  };
  const applyPrivateKey = (value: string) => {
    const normalized = normalizePrivateKey(value);
    if (!normalized) {
      Alert.alert(t('connection.noPrivateKeyTitle'), t('connection.noPrivateKeyCopy'));
      return;
    }
    setPrivateKey(normalized);
  };
  const pastePrivateKey = async () => {
    try {
      applyPrivateKey(await Clipboard.getString());
    } catch (error) {
      Alert.alert(t('connection.pasteError'), String(error));
    }
  };
  const selectPrivateKeyFile = async () => {
    if (!privateKeyFilePicker) {
      Alert.alert(t('connection.fileUnavailableTitle'), t('connection.fileUnavailableCopy'));
      return;
    }
    try {
      const value = await privateKeyFilePicker.pickPrivateKey();
      if (value != null) applyPrivateKey(value);
    } catch (error) {
      Alert.alert(t('connection.readKeyError'), String(error));
    }
  };
  const generatePrivateKey = async () => {
    setBusy(true);
    try {
      const generated = await SSHClient.generateKeyPair('ed25519', passphrase, 256, name.trim() || 'herdr');
      applyPrivateKey(generated.privateKey);
    } catch (error) {
      Alert.alert(t('connection.generateKeyError'), String(error));
    } finally {
      setBusy(false);
    }
  };
  const storeKey = async () => {
    if (!name.trim() || !privateKey) return;
    setBusy(true);
    try {
      const details = await SSHClient.getKeyDetails(privateKey, passphrase || undefined);
      updateKeys(await saveGlobalSshKey(keys, {
        name,
        fingerprint: details.fingerprint,
        keyType: details.keyType,
        secret: privateKey,
        passphrase,
      }));
      resetDraft();
    } catch (error: any) {
      Alert.alert(
        t('keychain.saveError'),
        error?.code === 'E_KEY_PASSPHRASE_REQUIRED'
          ? t('connection.enterPassphraseFirst')
          : error?.code === 'E_KEY_PASSPHRASE_INVALID'
            ? t('connection.incorrectPassphrase')
            : t('connection.unreadableKey'),
      );
    } finally {
      setBusy(false);
    }
  };
  const confirmDelete = (key: GlobalSshKeyMaterial) => {
    Alert.alert(t('keychain.deleteTitle', { name: key.name }), t('keychain.deleteCopy'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.remove'),
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          deleteGlobalSshKey(keys, key.id)
            .then(updateKeys)
            .catch(error => Alert.alert(t('keychain.deleteError'), String(error)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('keychain.title')}
        subtitle={t('keychain.count', { count: keys.length })}
        left={<IconButton icon={ChevronLeft} accessibilityLabel={t('connection.back')} onPress={onClose} />}
        right={!adding ? <IconButton icon={Plus} accessibilityLabel={t('keychain.add')} onPress={hapticPress(() => setAdding(true))} /> : undefined}
      />
      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
        <View className="p-4 pb-10">
          <View className="mb-5 flex-row items-start gap-3 rounded-lg bg-muted p-4">
            <Icon as={ShieldCheck} className="text-primary" size={21} />
            <View className="flex-1">
              <Text className="text-sm font-semibold">{t('keychain.protected')}</Text>
              <Text className="mt-1 text-xs leading-[18px] text-muted-foreground">{t('keychain.protectedCopy')}</Text>
            </View>
          </View>

          {adding ? (
            <View className="mb-5 rounded-lg border border-border bg-card p-4">
              <Text className="text-base font-semibold">{t('keychain.add')}</Text>
              <Text className="mb-4 mt-1 text-xs leading-[18px] text-muted-foreground">{t('keychain.addCopy')}</Text>
              <Text className="mb-1.5 text-xs font-medium text-muted-foreground">{t('keychain.keyName')}</Text>
              <Input value={name} onChangeText={setName} placeholder={t('keychain.keyNamePlaceholder')} />
              <Text className="mb-1.5 mt-3.5 text-xs font-medium text-muted-foreground">{t('connection.privateKey')}</Text>
              {privateKey ? (
                <View className="min-h-14 flex-row items-center rounded-md border border-border bg-muted px-3">
                  <Icon as={KeyRound} size={18} />
                  <Text className="ml-2 flex-1 text-[13px] font-medium">{t('connection.privateKeyLoaded')}</Text>
                  <IconButton icon={X} accessibilityLabel={t('connection.removePrivateKey')} className="size-9" onPress={() => setPrivateKey('')} />
                </View>
              ) : (
                <View className="flex-row gap-2">
                  <Button className="min-w-0 flex-1 rounded-full px-2" size="sm" variant="secondary" disabled={busy} onPress={hapticPress(pastePrivateKey)}><Icon as={ClipboardPaste} size={15} /><Text className="text-xs">{t('keychain.paste')}</Text></Button>
                  <Button className="min-w-0 flex-1 rounded-full px-2" size="sm" variant="secondary" disabled={busy} onPress={hapticPress(selectPrivateKeyFile)}><Icon as={FileUp} size={15} /><Text className="text-xs">{t('connection.selectFile')}</Text></Button>
                  <Button className="min-w-0 flex-1 rounded-full px-2" size="sm" variant="secondary" disabled={busy} onPress={hapticPress(generatePrivateKey)}><Icon as={Sparkles} size={15} /><Text className="text-xs">{t('keychain.generate')}</Text></Button>
                </View>
              )}
              <Text className="mb-1.5 mt-3.5 text-xs font-medium text-muted-foreground">{t('connection.keyPassphrase')}</Text>
              <Input value={passphrase} onChangeText={setPassphrase} secureTextEntry />
              <View className="mt-4 flex-row gap-2">
                <Button className="flex-1 rounded-full" variant="secondary" disabled={busy} onPress={hapticPress(resetDraft)}><Text>{t('common.cancel')}</Text></Button>
                <Button className="flex-1 rounded-full" disabled={busy || !name.trim() || !privateKey} onPress={hapticPress(storeKey)}><Text>{busy ? t('keychain.saving') : t('keychain.save')}</Text></Button>
              </View>
            </View>
          ) : null}

          {keys.length === 0 && !adding ? (
            <View className="min-h-[320px] items-center justify-center px-7">
              <View className="size-16 items-center justify-center rounded-full bg-muted"><Icon as={KeyRound} size={27} /></View>
              <Text className="mt-4 text-lg font-semibold">{t('keychain.emptyTitle')}</Text>
              <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{t('keychain.emptyCopy')}</Text>
              <Button className="mt-5 rounded-full" onPress={hapticPress(() => setAdding(true))}><Icon as={Plus} className="text-primary-foreground" size={17} /><Text>{t('keychain.add')}</Text></Button>
            </View>
          ) : (
            <View className="overflow-hidden rounded-lg border border-border bg-card">
              {keys.map((key, index) => (
                <View key={key.id} className={index ? 'min-h-[76px] flex-row items-center border-t border-border p-3.5' : 'min-h-[76px] flex-row items-center p-3.5'}>
                  <View className="size-10 items-center justify-center rounded-full bg-primary/10"><Icon as={KeyRound} className="text-primary" size={18} /></View>
                  <View className="ml-3 min-w-0 flex-1">
                    <Text className="text-[15px] font-semibold" numberOfLines={1}>{key.name}</Text>
                    <Text className="mt-0.5 font-mono text-[11px] text-muted-foreground" ellipsizeMode="middle" numberOfLines={1}>{key.fingerprint}</Text>
                    <Text className="mt-0.5 text-[11px] text-muted-foreground">{key.keyType}</Text>
                  </View>
                  <IconButton icon={Trash2} accessibilityLabel={t('keychain.remove', { name: key.name })} className="ml-2 size-10" disabled={busy} onPress={hapticPress(() => confirmDelete(key))} />
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
