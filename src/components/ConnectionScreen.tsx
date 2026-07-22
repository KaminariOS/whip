import { ArrowRight, ClipboardPaste, Copy, FileUp, KeyRound, Sparkles, Trash2, X } from 'lucide-react-native';
import SSHClient from '@dylankenneally/react-native-ssh-sftp';
import { useEffect, useState } from 'react';
import { Alert, Clipboard, KeyboardAvoidingView, Modal, NativeModules, Platform, Pressable, ScrollView, TextInput, ToastAndroid, View } from 'react-native';

import { normalizePrivateKey } from '@/src/lib/privateKey';
import { cn } from '@/src/lib/utils';
import type { ConnectionProfile } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader, WhipMark } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

interface Props {
  initialProfile: ConnectionProfile;
  connecting: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile) => void;
  onDelete?: () => void;
}

type KeyInspection =
  | { state: 'idle' | 'loading' }
  | { state: 'valid'; fingerprint: string; keyType: string; publicKey: string }
  | { state: 'passphrase-required' }
  | { state: 'invalid'; message: string };

type PrivateKeyFilePickerModule = {
  pickPrivateKey(): Promise<string | null>;
};

const privateKeyFilePicker = NativeModules.PrivateKeyFilePicker as PrivateKeyFilePickerModule | undefined;

export function ConnectionScreen({ initialProfile, connecting, error, onCancel, onSave, onConnect, onDelete }: Props) {
  const [profile, setProfile] = useState(initialProfile);
  const [keyInspection, setKeyInspection] = useState<KeyInspection>({ state: 'idle' });
  const [keyActionsOpen, setKeyActionsOpen] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);

  useEffect(() => { setProfile(initialProfile); setKeyActionsOpen(false); }, [initialProfile]);

  useEffect(() => {
    if (profile.authMode !== 'key' || !profile.secret.trim()) {
      setKeyInspection({ state: 'idle' });
      return;
    }

    let active = true;
    setKeyInspection({ state: 'loading' });
    const timeout = setTimeout(() => {
      SSHClient.getKeyDetails(normalizePrivateKey(profile.secret), profile.passphrase || undefined)
        .then(details => {
          if (active) setKeyInspection({
            state: 'valid',
            fingerprint: details.fingerprint,
            keyType: details.keyType,
            publicKey: details.publicKey,
          });
        })
        .catch((inspectionError: { code?: string; message?: string }) => {
          if (!active) return;
          if (inspectionError?.code === 'E_KEY_PASSPHRASE_REQUIRED') {
            setKeyInspection({ state: 'passphrase-required' });
            return;
          }
          setKeyInspection({
            state: 'invalid',
            message: inspectionError?.code === 'E_KEY_PASSPHRASE_INVALID'
              ? 'The key passphrase is incorrect.'
              : 'This private key could not be read.',
          });
        });
    }, 250);

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [profile.authMode, profile.passphrase, profile.secret]);

  const update = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => setProfile(current => ({ ...current, [key]: value }));
  const canSave = Boolean(profile.host.trim() && profile.username.trim());
  const canConnect = Boolean(canSave && profile.secret);
  const privateKeyAccessibilityLabel = keyInspection.state === 'valid'
    ? `${keyInspection.fingerprint}, ${keyInspection.keyType}. Tap for copy options.`
    : 'Private key loaded. Tap for copy options.';
  const removePrivateKey = () => {
    setProfile(current => ({ ...current, secret: '', passphrase: '' }));
    setKeyActionsOpen(false);
  };
  const applyPrivateKey = (value: string) => {
    const privateKey = normalizePrivateKey(value);
    if (!privateKey) {
      Alert.alert('No private key found', 'The clipboard or selected file is empty.');
      return;
    }
    setProfile(current => ({ ...current, secret: privateKey }));
    setKeyActionsOpen(false);
  };
  const pastePrivateKey = async () => {
    try {
      applyPrivateKey(await Clipboard.getString());
    } catch (pasteError) {
      Alert.alert('Could not paste private key', String(pasteError));
    }
  };
  const selectPrivateKeyFile = async () => {
    setKeyActionsOpen(false);
    if (!privateKeyFilePicker) {
      Alert.alert('File selection unavailable', 'This build does not include the private key file picker.');
      return;
    }
    try {
      const privateKey = await privateKeyFilePicker.pickPrivateKey();
      if (privateKey != null) applyPrivateKey(privateKey);
    } catch (fileError) {
      Alert.alert('Could not read private key', String(fileError));
    }
  };
  const generatePrivateKey = async () => {
    setKeyActionsOpen(false);
    setGeneratingKey(true);
    try {
      const generated = await SSHClient.generateKeyPair('ed25519', profile.passphrase || '', 256, profile.name.trim() || 'herdr');
      applyPrivateKey(generated.privateKey);
    } catch (generationError) {
      Alert.alert('Could not generate private key', String(generationError));
    } finally {
      setGeneratingKey(false);
    }
  };
  const copied = (label: string) => {
    setKeyActionsOpen(false);
    if (Platform.OS === 'android') ToastAndroid.show(`${label} copied`, ToastAndroid.SHORT);
    else Alert.alert(`${label} copied`);
  };
  const copyPrivateKey = () => {
    Clipboard.setString(profile.secret);
    copied('Private key');
  };
  const copyPublicKey = async () => {
    try {
      const publicKey = keyInspection.state === 'valid'
        ? keyInspection.publicKey
        : (await SSHClient.getKeyDetails(normalizePrivateKey(profile.secret), profile.passphrase || undefined)).publicKey;
      Clipboard.setString(publicKey);
      copied('Public key');
    } catch (copyError: any) {
      setKeyActionsOpen(false);
      Alert.alert(
        'Could not copy public key',
        copyError?.code === 'E_KEY_PASSPHRASE_REQUIRED'
          ? 'Enter the key passphrase first.'
          : copyError?.code === 'E_KEY_PASSPHRASE_INVALID'
            ? 'The key passphrase is incorrect.'
            : 'This private key could not be read.',
      );
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background">
      <ScreenHeader title={profile.name.trim() ? 'Edit host' : 'New host'} left={<IconButton icon="chevron-back" accessibilityLabel="Back" onPress={onCancel} />} />
      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled"><View className="p-4 pb-11">
        <View className="mb-[30px] flex-row items-center gap-3.5"><WhipMark size={48} /><View className="flex-1"><Text className="text-lg font-semibold leading-6">Remote Herdr connection</Text><Text className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">Herdr stays private on the host. This device connects over SSH and opens only the selected pane terminal.</Text></View></View>

        <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">Host identity</Text>
        <Field label="Display name" value={profile.name} placeholder={profile.host.trim() || 'Savior'} onChangeText={value => update('name', value)} />

        <Text className="mb-3 mt-3.5 px-1 text-sm font-semibold text-muted-foreground">SSH destination</Text>
        <View className="flex-row gap-2.5"><Field label="Tailscale host or IP" value={profile.host} placeholder="laptop.tailnet.ts.net" onChangeText={value => update('host', value)} className="flex-1" autoCapitalize="none" /><Field label="Port" value={profile.port} onChangeText={value => update('port', value)} keyboardType="number-pad" className="w-[88px]" /></View>
        <Field label="SSH user" value={profile.username} placeholder="kosumi" onChangeText={value => update('username', value)} autoCapitalize="none" />

        <View className="mb-4 flex-row rounded-full bg-muted p-1">
          {(['password', 'key'] as const).map(mode => <Button className={cn('h-[38px] flex-1 rounded-full', profile.authMode === mode && 'bg-background')} key={mode} variant="ghost" onPress={hapticPress(() => update('authMode', mode))}><Text className={cn('text-[13px] font-semibold', profile.authMode !== mode && 'text-muted-foreground')}>{mode === 'password' ? 'Password' : 'Private key'}</Text></Button>)}
        </View>

        {profile.authMode === 'password' ? (
          <Field label="SSH password" value={profile.secret} onChangeText={value => update('secret', value)} secureTextEntry autoCapitalize="none" />
        ) : (
          <View className="mb-3.5"><Text className="mb-1.5 text-xs font-medium text-muted-foreground">PEM / OpenSSH private key</Text><View className="min-h-[58px] w-full flex-row overflow-hidden rounded-md border border-border bg-card"><Button accessibilityLabel={profile.secret ? privateKeyAccessibilityLabel : 'Add private key'} className="min-h-[58px] min-w-0 flex-1 justify-start rounded-none px-3.5 py-2.5" disabled={generatingKey} size="content" variant="ghost" onPress={hapticPress(() => setKeyActionsOpen(true))}><Icon as={KeyRound} size={18} />{profile.secret ? (keyInspection.state === 'valid' ? <KeyIdentity fingerprint={keyInspection.fingerprint} keyType={keyInspection.keyType} /> : <Text className="min-w-0 flex-1 text-[13px] font-medium" numberOfLines={1}>Private key loaded</Text>) : <Text className="min-w-0 flex-1 text-[13px] font-medium" numberOfLines={1}>{generatingKey ? 'Generating Ed25519 key…' : 'Add private key'}</Text>}</Button>{profile.secret ? <Button accessibilityLabel="Remove private key" className="min-h-[58px] w-[52px] rounded-none border-l border-border px-0 py-0" size="content" variant="ghost" onPress={hapticPress(removePrivateKey)}><Icon as={X} className="text-muted-foreground" size={19} /></Button> : null}</View></View>
        )}
        {profile.authMode === 'key' && keyInspection.state !== 'idle' && keyInspection.state !== 'valid' ? (
            <Text
              accessibilityLiveRegion="polite"
              className={cn(
                '-mt-2 mb-3.5 px-1 text-xs leading-[17px]',
                keyInspection.state === 'invalid' && 'text-destructive',
                (keyInspection.state === 'loading' || keyInspection.state === 'passphrase-required') && 'text-muted-foreground',
              )}>
              {keyInspection.state === 'loading' && 'Inspecting private key…'}
              {keyInspection.state === 'passphrase-required' && 'Enter the key passphrase to inspect this encrypted key.'}
              {keyInspection.state === 'invalid' && keyInspection.message}
            </Text>
        ) : null}
        {profile.authMode === 'key' ? <Field label="Key passphrase (optional)" value={profile.passphrase} onChangeText={value => update('passphrase', value)} secureTextEntry /> : null}

        <View className="mb-3.5 mt-0.5 min-h-[74px] flex-row items-center gap-4 border-y border-border"><View className="flex-1"><Text className="text-[15px] font-semibold leading-5">Remember credentials</Text><Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">Keystore protected, with encrypted recovery unlocked by device security.</Text></View><Switch checked={profile.rememberCredentials} onCheckedChange={value => update('rememberCredentials', value)} /></View>

        <Text className="mb-3 mt-3.5 px-1 text-sm font-semibold text-muted-foreground">Herdr target</Text>
        <View className="flex-row gap-2.5"><Field label="Command" value={profile.herdrCommand} onChangeText={value => update('herdrCommand', value)} className="flex-1" autoCapitalize="none" /><Field label="Session" value={profile.sessionName} placeholder="default" onChangeText={value => update('sessionName', value)} className="w-[118px]" autoCapitalize="none" /></View>

        {error ? <Text className="my-2.5 text-[13px] leading-[18px] text-destructive">{error}</Text> : null}
        <View className="mt-2 flex-row gap-2.5"><Button className="flex-1 rounded-full" variant="secondary" disabled={!canSave || connecting} onPress={hapticPress(() => onSave(profile))}><Text>Save host</Text></Button><Button className="flex-1 rounded-full" disabled={!canConnect || connecting} onPress={hapticPress(() => onConnect(profile))}><Text>{connecting ? 'Opening SSH…' : 'Connect'}</Text><Icon as={ArrowRight} className="text-primary-foreground" size={17} /></Button></View>
        {onDelete ? <Button className="mt-3.5 rounded-full" variant="destructive" onPress={hapticPress(onDelete)}><Icon as={Trash2} className="text-destructive-foreground" size={17} /><Text>Delete host</Text></Button> : null}
        <Text className="mt-4 text-center text-[11px] leading-4 text-muted-foreground/70">Host-key pinning is not available yet. Use this connection only inside a trusted Tailscale network.</Text>
      </View></ScrollView>
      <PrivateKeyActions
        hasKey={Boolean(profile.secret)}
        visible={keyActionsOpen}
        onClose={() => setKeyActionsOpen(false)}
        onCopyPrivate={copyPrivateKey}
        onCopyPublic={copyPublicKey}
        onGenerate={generatePrivateKey}
        onPaste={pastePrivateKey}
        onSelectFile={selectPrivateKeyFile}
      />
    </KeyboardAvoidingView>
  );
}

interface FieldProps extends React.ComponentProps<typeof TextInput> { label: string; className?: string }

function Field({ label, className, multiline, ...props }: FieldProps) {
  return <View className={cn('mb-3.5', className)}><Text className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</Text><Input {...props} multiline={multiline} className={multiline ? 'min-h-[116px] font-mono text-xs' : undefined} textAlignVertical={multiline ? 'top' : 'center'} /></View>;
}

function KeyIdentity({ fingerprint, keyType }: { fingerprint: string; keyType: string }) {
  return <View className="min-w-0 flex-1 justify-center"><Text className="shrink font-mono text-[12px] leading-[17px]" ellipsizeMode="middle" numberOfLines={1}>{fingerprint}</Text><Text className="text-[11px] font-semibold leading-[17px] text-muted-foreground" numberOfLines={1}>{keyType}</Text></View>;
}

function PrivateKeyActions({ hasKey, visible, onClose, onCopyPrivate, onCopyPublic, onGenerate, onPaste, onSelectFile }: {
  hasKey: boolean;
  visible: boolean;
  onClose: () => void;
  onCopyPrivate: () => void;
  onCopyPublic: () => void;
  onGenerate: () => void;
  onPaste: () => void;
  onSelectFile: () => void;
}) {
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close private key actions" className="flex-1 justify-end bg-black/55" onPress={onClose}>
        <Pressable className="rounded-t-[28px] border-t border-border bg-card px-4 pb-8 pt-5" onPress={event => event.stopPropagation()}>
          <Text className="px-2 text-lg font-semibold">{hasKey ? 'Copy SSH key' : 'Add private key'}</Text>
          <Text className="mb-3 mt-1 px-2 text-[13px] leading-[18px] text-muted-foreground">
            {hasKey ? 'Choose which part of this keypair to copy.' : 'Choose how to add an SSH private key.'}
          </Text>
          {hasKey ? (
            <>
              <KeyAction icon={Copy} label="Copy private key" onPress={onCopyPrivate} />
              <KeyAction icon={KeyRound} label="Copy public key" onPress={onCopyPublic} />
            </>
          ) : (
            <>
              <KeyAction icon={ClipboardPaste} label="Paste from clipboard" onPress={onPaste} />
              <KeyAction icon={FileUp} label="Select file" onPress={onSelectFile} />
              <KeyAction icon={Sparkles} label="Generate new Ed25519 key" onPress={onGenerate} />
            </>
          )}
          <Button className="mt-2 rounded-full" variant="secondary" onPress={hapticPress(onClose)}><Text>Cancel</Text></Button>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function KeyAction({ icon, label, onPress }: { icon: typeof KeyRound; label: string; onPress: () => void }) {
  return <Button className="h-14 justify-start rounded-xl px-3" variant="ghost" onPress={hapticPress(onPress)}><Icon as={icon} size={19} /><Text className="text-[15px] font-medium">{label}</Text></Button>;
}
