import { ArrowRight, KeyRound, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';

import { cn } from '@/src/lib/utils';
import type { ConnectionProfile } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader } from './app-ui';
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

export function ConnectionScreen({ initialProfile, connecting, error, onCancel, onSave, onConnect, onDelete }: Props) {
  const [profile, setProfile] = useState(initialProfile);
  const [editingPrivateKey, setEditingPrivateKey] = useState(false);

  useEffect(() => { setProfile(initialProfile); setEditingPrivateKey(false); }, [initialProfile]);

  const update = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => setProfile(current => ({ ...current, [key]: value }));
  const canSave = Boolean(profile.host.trim() && profile.username.trim());
  const canConnect = Boolean(canSave && profile.secret);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background">
      <ScreenHeader title={profile.name.trim() ? 'Edit host' : 'New host'} left={<IconButton icon="chevron-back" accessibilityLabel="Back" onPress={onCancel} />} />
      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled"><View className="p-4 pb-11">
        <View className="mb-[30px] flex-row items-center gap-3.5"><View className="size-12 items-center justify-center rounded-full bg-primary"><Text className="text-[21px] font-bold text-primary-foreground">H</Text></View><View className="flex-1"><Text className="text-lg font-semibold leading-6">Remote Herdr connection</Text><Text className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">Herdr stays private on the host. This device connects over SSH and opens only the selected pane terminal.</Text></View></View>

        <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">Host identity</Text>
        <Field label="Display name" value={profile.name} placeholder="Savior" onChangeText={value => update('name', value)} />

        <Text className="mb-3 mt-3.5 px-1 text-sm font-semibold text-muted-foreground">SSH destination</Text>
        <View className="flex-row gap-2.5"><Field label="Tailscale host or IP" value={profile.host} placeholder="laptop.tailnet.ts.net" onChangeText={value => update('host', value)} className="flex-1" autoCapitalize="none" /><Field label="Port" value={profile.port} onChangeText={value => update('port', value)} keyboardType="number-pad" className="w-[88px]" /></View>
        <Field label="SSH user" value={profile.username} placeholder="kosumi" onChangeText={value => update('username', value)} autoCapitalize="none" />

        <View className="mb-4 flex-row rounded-full bg-muted p-1">
          {(['password', 'key'] as const).map(mode => <Button className={cn('h-[38px] flex-1 rounded-full', profile.authMode === mode && 'bg-background')} key={mode} variant="ghost" onPress={hapticPress(() => update('authMode', mode))}><Text className={cn('text-[13px] font-semibold', profile.authMode !== mode && 'text-muted-foreground')}>{mode === 'password' ? 'Password' : 'Private key'}</Text></Button>)}
        </View>

        {profile.authMode === 'key' && profile.secret && !editingPrivateKey ? (
          <View className="mb-3.5"><Text className="mb-1.5 text-xs font-medium text-muted-foreground">PEM / OpenSSH private key</Text><Button accessibilityLabel="Private key loaded. Tap to replace." className="h-[50px] w-full justify-start rounded-md border border-border bg-card px-3.5" variant="outline" onPress={hapticPress(() => setEditingPrivateKey(true))}><Icon as={KeyRound} size={18} /><Text className="text-[13px] font-medium">Private key loaded · Tap to replace</Text></Button></View>
        ) : (
          <Field label={profile.authMode === 'password' ? 'SSH password' : 'PEM / OpenSSH private key'} value={profile.secret} onChangeText={value => update('secret', value)} onBlur={() => setEditingPrivateKey(false)} secureTextEntry={profile.authMode === 'password'} multiline={profile.authMode === 'key'} numberOfLines={profile.authMode === 'key' ? 5 : 1} autoCapitalize="none" />
        )}
        {profile.authMode === 'key' ? <Field label="Key passphrase (optional)" value={profile.passphrase} onChangeText={value => update('passphrase', value)} secureTextEntry /> : null}

        <View className="mb-3.5 mt-0.5 min-h-[74px] flex-row items-center gap-4 border-y border-border"><View className="flex-1"><Text className="text-[15px] font-semibold leading-5">Remember credentials</Text><Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">Keystore protected, with encrypted recovery unlocked by device security.</Text></View><Switch checked={profile.rememberCredentials} onCheckedChange={value => update('rememberCredentials', value)} /></View>

        <Text className="mb-3 mt-3.5 px-1 text-sm font-semibold text-muted-foreground">Herdr target</Text>
        <View className="flex-row gap-2.5"><Field label="Command" value={profile.herdrCommand} onChangeText={value => update('herdrCommand', value)} className="flex-1" autoCapitalize="none" /><Field label="Session" value={profile.sessionName} placeholder="default" onChangeText={value => update('sessionName', value)} className="w-[118px]" autoCapitalize="none" /></View>

        {error ? <Text className="my-2.5 text-[13px] leading-[18px] text-destructive">{error}</Text> : null}
        <View className="mt-2 flex-row gap-2.5"><Button className="flex-1 rounded-full" variant="secondary" disabled={!canSave || connecting} onPress={hapticPress(() => onSave(profile))}><Text>Save host</Text></Button><Button className="flex-1 rounded-full" disabled={!canConnect || connecting} onPress={hapticPress(() => onConnect(profile))}><Text>{connecting ? 'Opening SSH…' : 'Connect'}</Text><Icon as={ArrowRight} className="text-primary-foreground" size={17} /></Button></View>
        {onDelete ? <Button className="mt-3.5 rounded-full" variant="destructive" onPress={hapticPress(onDelete)}><Icon as={Trash2} className="text-destructive-foreground" size={17} /><Text>Delete host</Text></Button> : null}
        <Text className="mt-4 text-center text-[11px] leading-4 text-muted-foreground/70">Host-key pinning is not available yet. Use this connection only inside a trusted Tailscale network.</Text>
      </View></ScrollView>
    </KeyboardAvoidingView>
  );
}

interface FieldProps extends React.ComponentProps<typeof TextInput> { label: string; className?: string }

function Field({ label, className, multiline, ...props }: FieldProps) {
  return <View className={cn('mb-3.5', className)}><Text className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</Text><Input {...props} multiline={multiline} className={multiline ? 'min-h-[116px] font-mono text-xs' : undefined} textAlignVertical={multiline ? 'top' : 'center'} /></View>;
}
