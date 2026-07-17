import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import type { TerminalPreferences } from '../services/devicePreferences';
import { radii, spacing, useTheme } from '../theme';
import { Button, IconButton, ScreenHeader, SectionLabel } from './ui';

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
  const { colors } = useTheme();
  return (
    <View style={[styles.page, { backgroundColor: colors.canvas }]}>
      <ScreenHeader title="Settings" left={<IconButton icon="chevron-back" label="Back" onPress={props.onBack} />} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.intro}>
          <Text style={[styles.title, { color: colors.text }]}>{props.host || 'Not connected'}</Text>
          <Text style={[styles.copy, { color: colors.textSecondary }]}>{props.host ? 'Dashboard updates and terminal traffic use the authenticated SSH connection.' : 'Select a saved host to open a Herdr connection.'}</Text>
        </View>

        <SectionLabel>Notifications</SectionLabel>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.divider }]}>
          <SettingRow title="Agent notifications" copy="Notify when an agent is blocked or done." value={props.alertsEnabled} onChange={props.onAlertsChange} />
          <SettingRow title="Speak state changes" copy="Read important transitions with Android TTS." value={props.ttsEnabled} onChange={props.onTtsChange} divided />
        </View>

        <View style={styles.sectionGap}><SectionLabel>Terminal</SectionLabel></View>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.divider }]}>
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
            divided
          />
          <SettingRow
            title="Blinking cursor"
            copy="Animate the terminal cursor while the pane is active."
            value={props.terminalPreferences.cursorBlink}
            onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, cursorBlink: value })}
            divided
          />
        </View>

        <View style={[styles.notice, { backgroundColor: colors.surface }]}>
          <Ionicons name="shield-checkmark-outline" size={21} color={colors.text} />
          <View style={styles.noticeBody}>
            <Text style={[styles.noticeTitle, { color: colors.text }]}>Private SSH boundary</Text>
            <Text style={[styles.noticeText, { color: colors.textSecondary }]}>Herdr is not exposed to the network. Dashboard actions and terminal bytes travel through SSH to your device.</Text>
          </View>
        </View>

        {props.onDisconnect && <Button label="Disconnect SSH" icon="log-out-outline" variant="destructive" onPress={props.onDisconnect} style={styles.disconnect} />}
      </ScrollView>
    </View>
  );
}

function ValueRow({ title, value, onDecrease, onIncrease, divided = false }: { title: string; value: string; onDecrease: () => void; onIncrease: () => void; divided?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.valueRow, divided && { borderTopColor: colors.divider, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <Text style={[styles.settingTitle, { color: colors.text }]}>{title}</Text>
      <View style={styles.valueActions}>
        <IconButton icon="remove" label={`Decrease ${title}`} size={36} onPress={onDecrease} />
        <Text style={[styles.valueText, { color: colors.textSecondary }]}>{value}</Text>
        <IconButton icon="add" label={`Increase ${title}`} size={36} onPress={onIncrease} />
      </View>
    </View>
  );
}

function SettingRow({ title, copy, value, onChange, divided = false }: { title: string; copy: string; value: boolean; onChange: (value: boolean) => void; divided?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.settingRow, divided && { borderTopColor: colors.divider, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.settingBody}>
        <Text style={[styles.settingTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.settingCopy, { color: colors.textSecondary }]}>{copy}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: colors.divider, true: colors.text }} thumbColor={value ? colors.canvas : colors.textTertiary} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 44 },
  intro: { paddingVertical: 8, marginBottom: 28 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  copy: { fontSize: 14, lineHeight: 21, marginTop: 6 },
  sectionGap: { marginTop: 28 },
  group: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  settingRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center', padding: 14 },
  settingBody: { flex: 1, paddingRight: 18 },
  settingTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  settingCopy: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  valueRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 },
  valueActions: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center' },
  valueText: { minWidth: 92, textAlign: 'center', fontSize: 12, lineHeight: 16 },
  notice: { borderRadius: radii.lg, padding: 16, marginTop: 28, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  noticeBody: { flex: 1 },
  noticeTitle: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  noticeText: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  disconnect: { marginTop: 24 },
});
