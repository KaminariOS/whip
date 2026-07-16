import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors } from '../theme';
import type { ConnectionProfile } from '../types';

interface Props {
  initialProfile: ConnectionProfile;
  connecting: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile) => void;
  onDelete?: () => void;
}

export function ConnectionScreen({
  initialProfile,
  connecting,
  error,
  onCancel,
  onSave,
  onConnect,
  onDelete,
}: Props) {
  const [profile, setProfile] = useState(initialProfile);
  const [editingPrivateKey, setEditingPrivateKey] = useState(false);

  useEffect(() => {
    setProfile(initialProfile);
    setEditingPrivateKey(false);
  }, [initialProfile]);

  const update = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => {
    setProfile(current => ({ ...current, [key]: value }));
  };

  const canSave = Boolean(profile.host.trim() && profile.username.trim());
  const canConnect = Boolean(canSave && profile.secret);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.editorHeader}>
          <Pressable accessibilityRole="button" onPress={onCancel} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>
          <Text style={styles.editorTitle}>{profile.name.trim() ? 'EDIT HOST' : 'NEW HOST'}</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.brandRow}>
          <Text style={styles.mark}>H/</Text>
          <View>
            <Text style={styles.brand}>HERDR REMOTE</Text>
            <Text style={styles.kicker}>TAILSCALE + SSH FIELD CONSOLE</Text>
          </View>
        </View>

        <View style={styles.introCard}>
          <Text style={styles.introNumber}>01</Text>
          <Text style={styles.introText}>
            Connect to the laptop exactly as you do in Termius. Herdr stays private on the laptop;
            this app turns Herdr management into native controls and opens a terminal only for the selected agent pane.
          </Text>
        </View>

        <Text style={styles.sectionLabel}>HOST IDENTITY</Text>
        <Field
          label="DISPLAY NAME"
          value={profile.name}
          placeholder="Savior"
          onChangeText={value => update('name', value)}
        />

        <Text style={styles.sectionLabel}>TAILNET DESTINATION</Text>
        <View style={styles.row}>
          <Field
            label="TAILSCALE HOST / IP"
            value={profile.host}
            placeholder="laptop.tailnet.ts.net"
            onChangeText={value => update('host', value)}
            style={styles.flex}
            autoCapitalize="none"
          />
          <Field
            label="PORT"
            value={profile.port}
            onChangeText={value => update('port', value)}
            keyboardType="number-pad"
            style={styles.port}
          />
        </View>
        <Field
          label="SSH USER"
          value={profile.username}
          placeholder="kosumi"
          onChangeText={value => update('username', value)}
          autoCapitalize="none"
        />

        <View style={styles.authTabs}>
          {(['password', 'key'] as const).map(mode => (
            <Pressable
              key={mode}
              onPress={() => update('authMode', mode)}
              style={[styles.authTab, profile.authMode === mode && styles.authTabActive]}>
              <Text style={[styles.authTabText, profile.authMode === mode && styles.authTabTextActive]}>
                {mode === 'password' ? 'PASSWORD' : 'PRIVATE KEY'}
              </Text>
            </Pressable>
          ))}
        </View>

        {profile.authMode === 'key' && profile.secret && !editingPrivateKey ? (
          <View style={styles.field}>
            <Text style={styles.label}>PEM / OPENSSH PRIVATE KEY</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Private key loaded. Tap to replace."
              onPress={() => setEditingPrivateKey(true)}
              style={styles.loadedSecret}>
              <Text style={styles.loadedSecretText}>PRIVATE KEY LOADED · TAP TO REPLACE</Text>
            </Pressable>
          </View>
        ) : (
          <Field
            label={profile.authMode === 'password' ? 'SSH PASSWORD' : 'PEM / OPENSSH PRIVATE KEY'}
            value={profile.secret}
            onChangeText={value => update('secret', value)}
            onBlur={() => setEditingPrivateKey(false)}
            secureTextEntry={profile.authMode === 'password'}
            multiline={profile.authMode === 'key'}
            numberOfLines={profile.authMode === 'key' ? 5 : 1}
            autoCapitalize="none"
          />
        )}
        {profile.authMode === 'key' && (
          <Field
            label="KEY PASSPHRASE (OPTIONAL)"
            value={profile.passphrase}
            onChangeText={value => update('passphrase', value)}
            secureTextEntry
          />
        )}

        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.switchTitle}>Remember credentials</Text>
            <Text style={styles.switchCopy}>Stored in Android Keystore, not plain app storage.</Text>
          </View>
          <Switch
            value={profile.rememberCredentials}
            onValueChange={value => update('rememberCredentials', value)}
            trackColor={{ false: colors.line, true: '#687b35' }}
            thumbColor={profile.rememberCredentials ? colors.acid : colors.muted}
          />
        </View>

        <Text style={styles.sectionLabel}>HERDR TARGET</Text>
        <View style={styles.row}>
          <Field
            label="COMMAND"
            value={profile.herdrCommand}
            onChangeText={value => update('herdrCommand', value)}
            style={styles.flex}
            autoCapitalize="none"
          />
          <Field
            label="SESSION"
            value={profile.sessionName}
            placeholder="default"
            onChangeText={value => update('sessionName', value)}
            style={styles.session}
            autoCapitalize="none"
          />
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable
          accessibilityRole="button"
          disabled={!canSave || connecting}
          onPress={() => onSave(profile)}
          style={({ pressed }) => [
            styles.save,
            (!canSave || connecting) && styles.connectDisabled,
            pressed && styles.connectPressed,
          ]}>
          <Text style={styles.saveText}>SAVE HOST</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!canConnect || connecting}
          onPress={() => onConnect(profile)}
          style={({ pressed }) => [
            styles.connect,
            (!canConnect || connecting) && styles.connectDisabled,
            pressed && styles.connectPressed,
          ]}>
          <Text style={styles.connectText}>{connecting ? 'OPENING SSH...' : 'CONNECT TO HERD  →'}</Text>
        </Pressable>
        {onDelete && (
          <Pressable accessibilityRole="button" onPress={onDelete} style={styles.deleteButton}>
            <Text style={styles.deleteText}>DELETE HOST</Text>
          </Pressable>
        )}
        <Text style={styles.securityNote}>
          The SSH dependency does not pin host keys yet. Use this only inside your trusted Tailscale
          network.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

interface FieldProps extends React.ComponentProps<typeof TextInput> {
  label: string;
  style?: object;
}

function Field({ label, style, multiline, ...props }: FieldProps) {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        multiline={multiline}
        placeholderTextColor="#697063"
        selectionColor={colors.acid}
        style={[styles.input, multiline && styles.multiline]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ink },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  editorHeader: { height: 44, flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -12 },
  backButtonText: { color: colors.text, fontFamily: 'monospace', fontSize: 34, lineHeight: 36 },
  editorTitle: { flex: 1, color: colors.text, textAlign: 'center', fontFamily: 'monospace', fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  headerSpacer: { width: 32 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 28 },
  mark: { color: colors.acid, fontFamily: 'monospace', fontSize: 42, fontWeight: '900' },
  brand: { color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: 1.2 },
  kicker: { color: colors.muted, fontFamily: 'monospace', fontSize: 10, letterSpacing: 1.4 },
  introCard: {
    borderLeftColor: colors.acid,
    borderLeftWidth: 2,
    backgroundColor: colors.panel,
    padding: 16,
    flexDirection: 'row',
    gap: 14,
    marginBottom: 30,
  },
  introNumber: { color: colors.acid, fontFamily: 'monospace', fontWeight: '800' },
  introText: { color: colors.text, flex: 1, fontSize: 14, lineHeight: 21 },
  sectionLabel: {
    color: colors.acid,
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 1.6,
    marginTop: 10,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  port: { width: 90 },
  session: { width: 118 },
  field: { marginBottom: 13 },
  label: { color: colors.muted, fontFamily: 'monospace', fontSize: 9, marginBottom: 6 },
  input: {
    color: colors.text,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontFamily: 'monospace',
    fontSize: 14,
  },
  loadedSecret: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 15,
  },
  loadedSecretText: { color: colors.acid, fontFamily: 'monospace', fontSize: 11, letterSpacing: 0.5 },
  multiline: { minHeight: 112, textAlignVertical: 'top' },
  authTabs: { flexDirection: 'row', marginBottom: 13, borderBottomColor: colors.line, borderBottomWidth: 1 },
  authTab: { paddingHorizontal: 14, paddingVertical: 10 },
  authTabActive: { borderBottomColor: colors.acid, borderBottomWidth: 2 },
  authTabText: { color: colors.muted, fontFamily: 'monospace', fontSize: 11 },
  authTabTextActive: { color: colors.acid },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 24 },
  switchTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  switchCopy: { color: colors.muted, fontSize: 11, marginTop: 3 },
  error: { color: colors.blocked, fontFamily: 'monospace', fontSize: 12, marginVertical: 10 },
  save: { borderColor: colors.line, borderWidth: 1, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  saveText: { color: colors.text, fontFamily: 'monospace', fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  connect: { backgroundColor: colors.acid, paddingVertical: 16, alignItems: 'center', marginTop: 10 },
  connectDisabled: { opacity: 0.35 },
  connectPressed: { transform: [{ translateY: 1 }] },
  connectText: { color: colors.ink, fontFamily: 'monospace', fontSize: 13, fontWeight: '900' },
  deleteButton: { alignItems: 'center', paddingVertical: 14, marginTop: 12 },
  deleteText: { color: colors.blocked, fontFamily: 'monospace', fontSize: 10, letterSpacing: 0.8 },
  securityNote: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 14 },
});
