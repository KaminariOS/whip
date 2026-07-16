import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { colors } from '../theme';
import type { TerminalPreferences } from '../services/devicePreferences';

interface Props {
  alertsEnabled: boolean;
  ttsEnabled: boolean;
  host: string | null;
  onBack: () => void;
  onAlertsChange: (value: boolean) => void;
  onTtsChange: (value: boolean) => void;
  terminalPreferences: TerminalPreferences;
  onTerminalPreferencesChange: (value: TerminalPreferences) => void;
  onDisconnect?: () => void;
}

export function SettingsScreen(props: Props) {
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" onPress={props.onBack} style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>
        <Text style={styles.headerTitle}>SETTINGS</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>REMOTE LINK</Text>
      <Text style={styles.title}>{props.host || 'Not connected'}</Text>
      <Text style={styles.copy}>{props.host ? 'Dashboard updates are pulled over authenticated SSH every 2.5 seconds.' : 'Select a saved host to open a Herdr connection.'}</Text>

      <View style={styles.section}>
        <SettingRow
          title="Agent notifications"
          copy="Notify and vibrate when an agent is blocked or done."
          value={props.alertsEnabled}
          onChange={props.onAlertsChange}
        />
        <SettingRow
          title="Speak state changes"
          copy="Read important agent transitions with Android TTS."
          value={props.ttsEnabled}
          onChange={props.onTtsChange}
        />
      </View>

      <Text style={styles.sectionLabel}>TERMINAL</Text>
      <View style={styles.section}>
        <ValueRow
          title="Font size"
          value={`${props.terminalPreferences.fontSize}px`}
          onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fontSize: Math.max(8, props.terminalPreferences.fontSize - 1) })}
          onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fontSize: Math.min(16, props.terminalPreferences.fontSize + 1) })}
        />
        <ValueRow
          title="Scrollback"
          value={`${props.terminalPreferences.scrollback} lines`}
          onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, scrollback: Math.max(1000, props.terminalPreferences.scrollback - 1000) })}
          onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, scrollback: Math.min(20000, props.terminalPreferences.scrollback + 1000) })}
        />
        <SettingRow
          title="Blinking cursor"
          copy="Animate the terminal cursor while the pane is active."
          value={props.terminalPreferences.cursorBlink}
          onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, cursorBlink: value })}
        />
      </View>

      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>TRUST BOUNDARY</Text>
        <Text style={styles.noticeText}>
          Herdr is not exposed to the network. Every dashboard action and terminal byte travels through
          the SSH connection to your Tailscale device.
        </Text>
      </View>

      {props.onDisconnect && (
        <Pressable onPress={props.onDisconnect} style={styles.disconnect}>
          <Text style={styles.disconnectText}>DISCONNECT SSH</Text>
        </Pressable>
      )}
      </ScrollView>
    </View>
  );
}

function ValueRow({ title, value, onDecrease, onIncrease }: { title: string; value: string; onDecrease: () => void; onIncrease: () => void }) {
  return (
    <View style={styles.valueRow}>
      <Text style={styles.settingTitle}>{title}</Text>
      <View style={styles.valueActions}>
        <Pressable onPress={onDecrease} style={styles.valueButton}><Text style={styles.valueButtonText}>−</Text></Pressable>
        <Text style={styles.valueText}>{value}</Text>
        <Pressable onPress={onIncrease} style={styles.valueButton}><Text style={styles.valueButtonText}>+</Text></Pressable>
      </View>
    </View>
  );
}

function SettingRow({ title, copy, value, onChange }: { title: string; copy: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingBody}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingCopy}>{copy}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.line, true: '#687b35' }}
        thumbColor={value ? colors.acid : colors.muted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ink },
  header: { height: 52, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: 1 },
  back: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  backText: { color: colors.text, fontSize: 31, lineHeight: 34 },
  headerTitle: { flex: 1, color: colors.text, textAlign: 'center', fontFamily: 'monospace', fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  headerSpacer: { width: 52 },
  content: { padding: 20, paddingBottom: 40 },
  eyebrow: { color: colors.acid, fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.5 },
  title: { color: colors.text, fontFamily: 'monospace', fontSize: 22, fontWeight: '900', marginTop: 7 },
  copy: { color: colors.muted, lineHeight: 20, marginTop: 7 },
  section: { marginTop: 26, borderTopColor: colors.line, borderTopWidth: 1 },
  sectionLabel: { color: colors.acid, fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.3, marginTop: 28 },
  settingRow: { minHeight: 86, flexDirection: 'row', alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: 1 },
  settingBody: { flex: 1, paddingRight: 18 },
  settingTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  settingCopy: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  valueRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: 1 },
  valueActions: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center' },
  valueButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panelRaised, borderColor: colors.line, borderWidth: 1 },
  valueButtonText: { color: colors.text, fontFamily: 'monospace', fontSize: 17 },
  valueText: { minWidth: 92, color: colors.muted, textAlign: 'center', fontFamily: 'monospace', fontSize: 9 },
  notice: { backgroundColor: colors.panel, borderLeftColor: colors.acid, borderLeftWidth: 2, padding: 16, marginTop: 26 },
  noticeTitle: { color: colors.acid, fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.2 },
  noticeText: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  disconnect: { borderColor: colors.blocked, borderWidth: 1, padding: 14, alignItems: 'center', marginTop: 30 },
  disconnectText: { color: colors.blocked, fontFamily: 'monospace', fontWeight: '900', fontSize: 11 },
});
