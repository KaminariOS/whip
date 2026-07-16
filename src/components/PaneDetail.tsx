import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AnsiOutput } from './AnsiOutput';
import type { HerdrClient } from '../services/HerdrClient';
import { colors, statusColor } from '../theme';
import type { PaneInfo } from '../types';

interface Props {
  pane: PaneInfo | null;
  client: HerdrClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpenTerminal: (pane: PaneInfo) => void;
}

async function loadPane(client: HerdrClient, pane: PaneInfo, setOutput: (value: string) => void) {
  try {
    setOutput(await client.readPane(pane.pane_id));
  } catch (error) {
    setOutput(`Unable to read pane: ${String(error)}`);
  }
}

export function PaneDetail({ pane, client, onClose, onChanged, onOpenTerminal }: Props) {
  const loadedPaneId = useRef<string | null>(null);
  const [output, setOutput] = useState('');
  const [command, setCommand] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const read = () => pane && loadPane(client, pane, setOutput);

  useEffect(() => {
    if (!pane) {
      loadedPaneId.current = null;
      return;
    }
    if (loadedPaneId.current !== pane.pane_id) {
      loadedPaneId.current = pane.pane_id;
      setLabel(pane.label || '');
      setOutput('');
    }
    loadPane(client, pane, setOutput);
  }, [client, pane]);

  if (!pane) return null;

  const run = async (action: () => Promise<void>, close = false) => {
    setBusy(true);
    try {
      await action();
      await onChanged();
      if (close) onClose();
      else await read();
    } catch (error) {
      Alert.alert('Herdr command failed', String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerBody}>
              <Text style={styles.eyebrow}>{pane.workspace_id} / {pane.tab_id} / {pane.pane_id}</Text>
              <Text numberOfLines={1} style={styles.title}>{pane.label || pane.display_agent || pane.agent || 'Terminal pane'}</Text>
            </View>
            <View style={[styles.badge, { borderColor: statusColor(pane.agent_status) }]}>
              <Text style={[styles.badgeText, { color: statusColor(pane.agent_status) }]}>{pane.agent_status.toUpperCase()}</Text>
            </View>
            <Pressable onPress={onClose} style={styles.close}><Text style={styles.closeText}>×</Text></Pressable>
          </View>

          <View style={styles.renameRow}>
            <TextInput value={label} onChangeText={setLabel} placeholder="Pane label" placeholderTextColor={colors.muted} style={styles.renameInput} />
            <Pressable disabled={busy} onPress={() => run(() => client.renamePane(pane.pane_id, label))} style={styles.smallButton}>
              <Text style={styles.smallText}>SAVE NAME</Text>
            </Pressable>
          </View>

          <View style={styles.actionRail}>
            <Action label="SPLIT →" onPress={() => run(() => client.splitPane(pane.pane_id, 'right'))} />
            <Action label="SPLIT ↓" onPress={() => run(() => client.splitPane(pane.pane_id, 'down'))} />
            <Action label="ZOOM" onPress={() => run(() => client.zoomPane(pane.pane_id))} />
            <Action label="TERMINAL" accent onPress={() => onOpenTerminal(pane)} />
          </View>

          <View style={styles.outputHeader}>
            <Text style={styles.outputLabel}>LIVE PANE OUTPUT</Text>
            <Pressable onPress={read}><Text style={styles.refresh}>REFRESH</Text></Pressable>
          </View>
          <View style={styles.output}>
            {output ? <AnsiOutput value={output} /> : <ActivityIndicator color={colors.acid} style={styles.outputSpinner} />}
          </View>

          <View style={styles.keyRail}>
            {[
              ['ESC', 'esc'], ['CTRL+C', 'ctrl+c'], ['TAB', 'tab'], ['↑', 'up'], ['↓', 'down'], ['ENTER', 'enter'],
            ].map(([title, key]) => (
              <Pressable key={title} onPress={() => run(() => client.sendPaneKeys(pane.pane_id, [key]))} style={styles.key}>
                <Text style={styles.keyText}>{title}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.composer}>
            <TextInput value={command} onChangeText={setCommand} placeholder="Send command or response..." placeholderTextColor={colors.muted} style={styles.commandInput} />
            <Pressable disabled={!command.trim() || busy} onPress={() => run(async () => { await client.runInPane(pane.pane_id, command); setCommand(''); })} style={styles.send}>
              <Text style={styles.sendText}>SEND ↵</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={() => Alert.alert('Close pane?', pane.label || pane.pane_id, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Close', style: 'destructive', onPress: () => run(() => client.closePane(pane.pane_id), true) },
            ])}
            style={styles.closePane}>
            <Text style={styles.closePaneText}>CLOSE PANE</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Action({ label, onPress, accent = false }: { label: string; onPress: () => void; accent?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.action, accent && styles.actionAccent]}>
      <Text style={[styles.actionText, accent && styles.actionAccentText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000099' },
  sheet: { height: '94%', backgroundColor: colors.panel, borderTopColor: colors.acid, borderTopWidth: 2, padding: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerBody: { flex: 1 },
  eyebrow: { color: colors.muted, fontFamily: 'monospace', fontSize: 8 },
  title: { color: colors.text, fontSize: 21, fontWeight: '900', marginTop: 3 },
  badge: { borderWidth: 1, paddingHorizontal: 7, paddingVertical: 4 },
  badgeText: { fontFamily: 'monospace', fontSize: 8 },
  close: { width: 32, alignItems: 'center' },
  closeText: { color: colors.text, fontSize: 27 },
  renameRow: { flexDirection: 'row', marginTop: 12 },
  renameInput: { flex: 1, color: colors.text, backgroundColor: colors.ink, borderColor: colors.line, borderWidth: 1, paddingHorizontal: 10, fontSize: 12 },
  smallButton: { backgroundColor: colors.panelRaised, borderColor: colors.line, borderWidth: 1, padding: 11 },
  smallText: { color: colors.acid, fontFamily: 'monospace', fontSize: 8 },
  actionRail: { flexDirection: 'row', gap: 6, marginVertical: 10 },
  action: { borderColor: colors.line, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 },
  actionAccent: { marginLeft: 'auto', backgroundColor: colors.acid, borderColor: colors.acid },
  actionText: { color: colors.text, fontFamily: 'monospace', fontSize: 8, fontWeight: '800' },
  actionAccentText: { color: colors.ink },
  outputHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  outputLabel: { color: colors.acid, fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.1 },
  refresh: { color: colors.muted, fontFamily: 'monospace', fontSize: 8 },
  output: { flex: 1, backgroundColor: colors.ink, borderColor: colors.line, borderWidth: 1 },
  outputSpinner: { flex: 1 },
  keyRail: { flexDirection: 'row', marginTop: 8 },
  key: { flex: 1, paddingVertical: 9, alignItems: 'center', borderColor: colors.line, borderWidth: 1 },
  keyText: { color: colors.text, fontFamily: 'monospace', fontSize: 8 },
  composer: { flexDirection: 'row', marginTop: 8 },
  commandInput: { flex: 1, color: colors.text, backgroundColor: colors.ink, borderColor: colors.line, borderWidth: 1, paddingHorizontal: 10, fontSize: 13 },
  send: { backgroundColor: colors.acid, paddingHorizontal: 15, justifyContent: 'center' },
  sendText: { color: colors.ink, fontFamily: 'monospace', fontSize: 9, fontWeight: '900' },
  closePane: { alignItems: 'center', padding: 10, marginTop: 7 },
  closePaneText: { color: colors.blocked, fontFamily: 'monospace', fontSize: 8 },
});
