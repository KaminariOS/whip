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
import { colors, radii, spacing, useTheme } from '../theme';
import type { PaneInfo } from '../types';
import { Button, IconButton, Input, StatusBadge } from './ui';

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
  const { colors: theme } = useTheme();
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
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.backdrop, { backgroundColor: theme.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: theme.canvas }]}>
          <View style={[styles.handle, { backgroundColor: theme.divider }]} />
          <View style={styles.header}>
            <View style={styles.headerBody}>
              <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>{pane.workspace_id} · {pane.tab_id} · {pane.pane_id}</Text>
              <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>{pane.label || pane.display_agent || pane.agent || 'Terminal pane'}</Text>
            </View>
            <StatusBadge status={pane.agent_status} />
            <IconButton icon="close" label="Close pane details" onPress={onClose} />
          </View>

          <View style={styles.renameRow}>
            <Input value={label} onChangeText={setLabel} placeholder="Pane label" style={styles.renameInput} />
            <Button label="Save" variant="secondary" compact disabled={busy} onPress={() => run(() => client.renamePane(pane.pane_id, label))} />
          </View>

          <View style={styles.actionRail}>
            <Button label="Split right" icon="return-down-forward-outline" variant="secondary" compact onPress={() => run(() => client.splitPane(pane.pane_id, 'right'))} />
            <Button label="Split down" icon="return-down-back-outline" variant="secondary" compact onPress={() => run(() => client.splitPane(pane.pane_id, 'down'))} />
            <IconButton icon="expand-outline" label="Zoom pane" onPress={() => run(() => client.zoomPane(pane.pane_id))} />
            <Button label="Open" icon="terminal-outline" compact onPress={() => onOpenTerminal(pane)} />
          </View>

          <View style={styles.outputHeader}>
            <Text style={[styles.outputLabel, { color: theme.text }]}>Live pane output</Text>
            <IconButton icon="refresh" label="Refresh pane output" size={34} onPress={read} />
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

          <View style={[styles.composer, { backgroundColor: theme.surface, borderColor: theme.divider }]}>
            <TextInput value={command} onChangeText={setCommand} placeholder="Send a command or response" placeholderTextColor={theme.textSecondary} style={[styles.commandInput, { color: theme.text }]} />
            <IconButton icon="arrow-up" label="Send command" disabled={!command.trim() || busy} selected={Boolean(command.trim())} onPress={() => run(async () => { await client.runInPane(pane.pane_id, command); setCommand(''); })} />
          </View>

          <Button
            label="Close pane"
            icon="trash-outline"
            variant="destructive"
            onPress={() => Alert.alert('Close pane?', pane.label || pane.pane_id, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Close', style: 'destructive', onPress: () => run(() => client.closePane(pane.pane_id), true) },
            ])}
            style={styles.closePane}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { height: '94%', borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, padding: spacing.lg },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerBody: { flex: 1 },
  eyebrow: { fontSize: 11, lineHeight: 15 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600', marginTop: 2 },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  renameInput: { flex: 1 },
  actionRail: { flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 12 },
  outputHeader: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  outputLabel: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  output: { flex: 1, backgroundColor: colors.ink, borderRadius: radii.md, overflow: 'hidden' },
  outputSpinner: { flex: 1 },
  keyRail: { flexDirection: 'row', gap: 4, marginTop: 8 },
  key: { flex: 1, minHeight: 34, borderRadius: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.panelRaised },
  keyText: { color: colors.text, fontFamily: 'monospace', fontSize: 8 },
  composer: { minHeight: 52, flexDirection: 'row', alignItems: 'center', borderRadius: 26, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 14, paddingRight: 6, marginTop: 10 },
  commandInput: { flex: 1, fontSize: 15, lineHeight: 21 },
  closePane: { marginTop: 8 },
});
