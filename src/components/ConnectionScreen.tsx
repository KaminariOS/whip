import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { radii, spacing, useTheme } from '../theme';
import type { ConnectionProfile } from '../types';
import { Button, IconButton, Input, ScreenHeader, SectionLabel } from './ui';

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
  const { colors } = useTheme();
  const [profile, setProfile] = useState(initialProfile);
  const [editingPrivateKey, setEditingPrivateKey] = useState(false);

  useEffect(() => {
    setProfile(initialProfile);
    setEditingPrivateKey(false);
  }, [initialProfile]);

  const update = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => setProfile(current => ({ ...current, [key]: value }));
  const canSave = Boolean(profile.host.trim() && profile.username.trim());
  const canConnect = Boolean(canSave && profile.secret);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.page, { backgroundColor: colors.canvas }]}>
      <ScreenHeader title={profile.name.trim() ? 'Edit host' : 'New host'} left={<IconButton icon="chevron-back" label="Back" onPress={onCancel} />} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.intro}>
          <View style={[styles.brandMark, { backgroundColor: colors.primary }]}><Text style={[styles.brandText, { color: colors.onPrimary }]}>H</Text></View>
          <View style={styles.introCopy}>
            <Text style={[styles.introTitle, { color: colors.text }]}>Remote Herdr connection</Text>
            <Text style={[styles.introText, { color: colors.textSecondary }]}>Herdr stays private on the host. This device connects over SSH and opens only the selected pane terminal.</Text>
          </View>
        </View>

        <SectionLabel>Host identity</SectionLabel>
        <Field label="Display name" value={profile.name} placeholder="Savior" onChangeText={value => update('name', value)} />

        <View style={styles.sectionGap}><SectionLabel>SSH destination</SectionLabel></View>
        <View style={styles.row}>
          <Field label="Tailscale host or IP" value={profile.host} placeholder="laptop.tailnet.ts.net" onChangeText={value => update('host', value)} style={styles.flex} autoCapitalize="none" />
          <Field label="Port" value={profile.port} onChangeText={value => update('port', value)} keyboardType="number-pad" style={styles.port} />
        </View>
        <Field label="SSH user" value={profile.username} placeholder="kosumi" onChangeText={value => update('username', value)} autoCapitalize="none" />

        <View style={[styles.authTabs, { backgroundColor: colors.surface }]}>
          {(['password', 'key'] as const).map(mode => {
            const active = profile.authMode === mode;
            return (
              <Pressable key={mode} onPress={() => update('authMode', mode)} style={[styles.authTab, active && { backgroundColor: colors.canvas }]}>
                <Text style={[styles.authTabText, { color: active ? colors.text : colors.textSecondary }]}>{mode === 'password' ? 'Password' : 'Private key'}</Text>
              </Pressable>
            );
          })}
        </View>

        {profile.authMode === 'key' && profile.secret && !editingPrivateKey ? (
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>PEM / OpenSSH private key</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Private key loaded. Tap to replace." onPress={() => setEditingPrivateKey(true)} style={[styles.loadedSecret, { backgroundColor: colors.surface, borderColor: colors.divider }]}>
              <Ionicons name="key-outline" size={18} color={colors.text} />
              <Text style={[styles.loadedSecretText, { color: colors.text }]}>Private key loaded · Tap to replace</Text>
            </Pressable>
          </View>
        ) : (
          <Field
            label={profile.authMode === 'password' ? 'SSH password' : 'PEM / OpenSSH private key'}
            value={profile.secret}
            onChangeText={value => update('secret', value)}
            onBlur={() => setEditingPrivateKey(false)}
            secureTextEntry={profile.authMode === 'password'}
            multiline={profile.authMode === 'key'}
            numberOfLines={profile.authMode === 'key' ? 5 : 1}
            autoCapitalize="none"
          />
        )}
        {profile.authMode === 'key' && <Field label="Key passphrase (optional)" value={profile.passphrase} onChangeText={value => update('passphrase', value)} secureTextEntry />}

        <View style={[styles.switchRow, { borderColor: colors.divider }]}>
          <View style={styles.flex}>
            <Text style={[styles.switchTitle, { color: colors.text }]}>Remember credentials</Text>
            <Text style={[styles.switchCopy, { color: colors.textSecondary }]}>Stored in Android Keystore, not plain app storage.</Text>
          </View>
          <Switch value={profile.rememberCredentials} onValueChange={value => update('rememberCredentials', value)} trackColor={{ false: colors.divider, true: colors.text }} thumbColor={profile.rememberCredentials ? colors.canvas : colors.textTertiary} />
        </View>

        <View style={styles.sectionGap}><SectionLabel>Herdr target</SectionLabel></View>
        <View style={styles.row}>
          <Field label="Command" value={profile.herdrCommand} onChangeText={value => update('herdrCommand', value)} style={styles.flex} autoCapitalize="none" />
          <Field label="Session" value={profile.sessionName} placeholder="default" onChangeText={value => update('sessionName', value)} style={styles.session} autoCapitalize="none" />
        </View>

        {error && <Text style={[styles.error, { color: colors.error }]}>{error}</Text>}
        <View style={styles.actions}>
          <Button label="Save host" variant="secondary" disabled={!canSave || connecting} onPress={() => onSave(profile)} style={styles.action} />
          <Button label={connecting ? 'Opening SSH…' : 'Connect'} icon="arrow-forward" disabled={!canConnect || connecting} onPress={() => onConnect(profile)} style={styles.action} />
        </View>
        {onDelete && <Button label="Delete host" icon="trash-outline" variant="destructive" onPress={onDelete} style={styles.deleteButton} />}
        <Text style={[styles.securityNote, { color: colors.textTertiary }]}>Host-key pinning is not available yet. Use this connection only inside a trusted Tailscale network.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

interface FieldProps extends React.ComponentProps<typeof TextInput> { label: string; style?: object }

function Field({ label, style, multiline, ...props }: FieldProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.field, style]}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      <Input {...props} multiline={multiline} selectionColor={colors.text} style={multiline ? styles.multiline : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 44 },
  intro: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 30 },
  brandMark: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  brandText: { fontSize: 21, fontWeight: '700' },
  introCopy: { flex: 1 },
  introTitle: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  introText: { fontSize: 13, lineHeight: 19, marginTop: 3 },
  sectionGap: { marginTop: 14 },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  port: { width: 88 },
  session: { width: 118 },
  field: { marginBottom: 14 },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '500', marginBottom: 6 },
  multiline: { minHeight: 116, textAlignVertical: 'top', fontFamily: 'monospace', fontSize: 12 },
  loadedSecret: { minHeight: 50, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 9 },
  loadedSecretText: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  authTabs: { flexDirection: 'row', borderRadius: radii.full, padding: 4, marginBottom: 16 },
  authTab: { flex: 1, minHeight: 38, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  authTabText: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  switchRow: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 16, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, marginTop: 2, marginBottom: 14 },
  switchTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  switchCopy: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  error: { fontSize: 13, lineHeight: 18, marginVertical: 10 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  action: { flex: 1 },
  deleteButton: { marginTop: 14 },
  securityNote: { fontSize: 11, lineHeight: 16, marginTop: 16, textAlign: 'center' },
});
