import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, View } from 'react-native';

import { AnsiOutput } from './AnsiOutput';
import type { HerdrClient } from '@/src/services/HerdrClient';
import { colors, useTheme } from '@/src/theme';
import type { PaneInfo } from '@/src/types';
import { hapticPress, IconButton, StatusBadge } from './app-ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props { pane: PaneInfo | null; client: HerdrClient; onClose: () => void; onChanged: () => Promise<void>; onOpenTerminal: (pane: PaneInfo) => void }

async function loadPane(client: HerdrClient, pane: PaneInfo, setOutput: (value: string) => void) { try { setOutput(await client.readPane(pane.pane_id)); } catch (error) { setOutput(`Unable to read pane: ${String(error)}`); } }

export function PaneDetail({ pane, client, onClose, onChanged, onOpenTerminal }: Props) {
  const { colors: theme } = useTheme();
  const loadedPaneId = useRef<string | null>(null);
  const [output, setOutput] = useState(''); const [command, setCommand] = useState(''); const [label, setLabel] = useState(''); const [busy, setBusy] = useState(false);
  const read = () => pane && loadPane(client, pane, setOutput);

  useEffect(() => { if (!pane) { loadedPaneId.current = null; return; } if (loadedPaneId.current !== pane.pane_id) { loadedPaneId.current = pane.pane_id; setLabel(pane.label || ''); setOutput(''); } loadPane(client, pane, setOutput); }, [client, pane]);
  if (!pane) return null;

  const run = async (action: () => Promise<void>, close = false) => { setBusy(true); try { await action(); await onChanged(); if (close) onClose(); else await read(); } catch (error) { Alert.alert('Herdr command failed', String(error)); } finally { setBusy(false); } };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-end" style={{ backgroundColor: theme.scrim }}>
        <View className="h-[94%] rounded-t-[28px] bg-background p-4">
          <View className="mb-3.5 h-1 w-9 self-center rounded-full bg-border" />
          <View className="flex-row items-center gap-2.5"><View className="flex-1"><Text className="text-[11px] leading-[15px] text-muted-foreground">{pane.workspace_id} · {pane.tab_id} · {pane.pane_id}</Text><Text className="mt-0.5 text-xl font-semibold leading-[26px]" numberOfLines={1}>{pane.label || pane.display_agent || pane.agent || 'Terminal pane'}</Text></View><StatusBadge status={pane.agent_status} /><IconButton icon="close" accessibilityLabel="Close pane details" onPress={onClose} /></View>
          <View className="mt-3.5 flex-row items-center gap-2"><Input className="flex-1" value={label} onChangeText={setLabel} placeholder="Pane label" /><Button size="sm" variant="secondary" disabled={busy} onPress={hapticPress(() => run(() => client.renamePane(pane.pane_id, label)))}><Text>Save</Text></Button></View>
          <View className="my-3 flex-row items-center gap-1.5"><Action label="Split right" icon="return-down-forward-outline" onPress={() => run(() => client.splitPane(pane.pane_id, 'right'))} /><Action label="Split down" icon="return-down-back-outline" onPress={() => run(() => client.splitPane(pane.pane_id, 'down'))} /><IconButton icon="expand-outline" accessibilityLabel="Zoom pane" onPress={() => run(() => client.zoomPane(pane.pane_id))} /><Button size="sm" onPress={hapticPress(() => onOpenTerminal(pane))}><Ionicons name="terminal-outline" size={16} color={theme.onPrimary} /><Text>Open</Text></Button></View>
          <View className="min-h-9 flex-row items-center justify-between"><Text className="text-sm font-semibold">Live pane output</Text><IconButton icon="refresh" accessibilityLabel="Refresh pane output" className="size-[34px]" onPress={read} /></View>
          <View className="flex-1 overflow-hidden rounded-md bg-[#212121]">{output ? <AnsiOutput value={output} /> : <ActivityIndicator color={colors.acid} className="flex-1" />}</View>
          <View className="mt-2 flex-row gap-1">{[['ESC', 'esc'], ['CTRL+C', 'ctrl+c'], ['TAB', 'tab'], ['↑', 'up'], ['↓', 'down'], ['ENTER', 'enter']].map(([title, key]) => <Button className="h-[34px] flex-1 rounded-sm bg-[#2F2F2F] px-1" key={title} variant="secondary" onPress={hapticPress(() => run(() => client.sendPaneKeys(pane.pane_id, [key])))}><Text className="font-mono text-[8px] text-[#ECECEC]">{title}</Text></Button>)}</View>
          <View className="mt-2.5 min-h-[52px] flex-row items-center rounded-full border border-border bg-card py-1 pl-3.5 pr-1.5"><Input className="h-10 flex-1 border-0 bg-transparent px-0 shadow-none" value={command} onChangeText={setCommand} placeholder="Send a command or response" /><IconButton icon="arrow-up" accessibilityLabel="Send command" disabled={!command.trim() || busy} selected={Boolean(command.trim())} onPress={() => run(async () => { await client.runInPane(pane.pane_id, command); setCommand(''); })} /></View>
          <Button className="mt-2 rounded-full" variant="destructive" onPress={hapticPress(() => Alert.alert('Close pane?', pane.label || pane.pane_id, [{ text: 'Cancel', style: 'cancel' }, { text: 'Close', style: 'destructive', onPress: () => run(() => client.closePane(pane.pane_id), true) }]))}><Ionicons name="trash-outline" size={17} color="#FFFFFF" /><Text>Close pane</Text></Button>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Action({ label, icon, onPress }: { label: string; icon: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void }) { const { colors: theme } = useTheme(); return <Button size="sm" variant="secondary" onPress={hapticPress(onPress)}><Ionicons name={icon} size={15} color={theme.text} /><Text>{label}</Text></Button>; }
