import { ArrowUp, Maximize2, PanelBottomOpen, PanelRightOpen, RefreshCw, SquareTerminal, Trash2, X, type LucideIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AnsiOutput } from './AnsiOutput';
import type { HerdrClient } from '@/src/services/HerdrClient';
import { colors, useTheme } from '@/src/theme';
import type { PaneInfo } from '@/src/types';
import { hapticPress, IconButton, StatusBadge } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props { pane: PaneInfo | null; client: HerdrClient; onClose: () => void; onChanged: () => Promise<void>; onOpenTerminal: (pane: PaneInfo) => void }

async function loadPane(client: HerdrClient, pane: PaneInfo, setOutput: (value: string) => void, errorText: (error: unknown) => string) { try { setOutput(await client.readPane(pane.pane_id)); } catch (error) { setOutput(errorText(error)); } }

export function PaneDetail({ pane, client, onClose, onChanged, onOpenTerminal }: Props) {
  const { colors: theme } = useTheme();
  const { t } = useTranslation();
  const loadedPaneId = useRef<string | null>(null);
  const [output, setOutput] = useState(''); const [command, setCommand] = useState(''); const [label, setLabel] = useState(''); const [busy, setBusy] = useState(false);
  const read = () => pane && loadPane(client, pane, setOutput, error => t('pane.readError', { error: String(error) }));

  useEffect(() => { if (!pane) { loadedPaneId.current = null; return; } if (loadedPaneId.current !== pane.pane_id) { loadedPaneId.current = pane.pane_id; setLabel(pane.label || ''); setOutput(''); } loadPane(client, pane, setOutput, error => t('pane.readError', { error: String(error) })); }, [client, pane, t]);
  if (!pane) return null;

  const run = async (action: () => Promise<void>, close = false) => { setBusy(true); try { await action(); await onChanged(); if (close) onClose(); else await read(); } catch (error) { Alert.alert(t('herd.commandFailed'), String(error)); } finally { setBusy(false); } };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-end" style={{ backgroundColor: theme.scrim }}>
        <View className="h-[94%] rounded-t-[28px] bg-background p-4">
          <View className="mb-3.5 h-1 w-9 self-center rounded-full bg-border" />
          <View className="flex-row items-center gap-2.5"><View className="flex-1"><Text className="text-[11px] leading-[15px] text-muted-foreground">{pane.workspace_id} · {pane.tab_id} · {pane.pane_id}</Text><Text className="mt-0.5 text-xl font-semibold leading-[26px]" numberOfLines={1}>{pane.label || pane.display_agent || pane.agent || t('pane.titleFallback')}</Text></View><StatusBadge agentStatus status={pane.agent_status} /><IconButton icon={X} accessibilityLabel={t('pane.closeDetails')} onPress={onClose} /></View>
          <View className="mt-3.5 flex-row items-center gap-2"><Input className="flex-1" value={label} onChangeText={setLabel} placeholder={t('pane.label')} /><Button size="sm" variant="secondary" disabled={busy} onPress={hapticPress(() => run(() => client.renamePane(pane.pane_id, label)))}><Text>{t('common.save')}</Text></Button></View>
          <View className="my-3 flex-row items-center gap-1.5"><Action label={t('pane.splitRight')} icon={PanelRightOpen} onPress={() => run(() => client.splitPane(pane.pane_id, 'right'))} /><Action label={t('pane.splitDown')} icon={PanelBottomOpen} onPress={() => run(() => client.splitPane(pane.pane_id, 'down'))} /><IconButton icon={Maximize2} accessibilityLabel={t('pane.zoom')} onPress={() => run(() => client.zoomPane(pane.pane_id))} /><Button size="sm" onPress={hapticPress(() => onOpenTerminal(pane))}><Icon as={SquareTerminal} size={16} color={theme.onPrimary} /><Text>{t('pane.open')}</Text></Button></View>
          <View className="min-h-9 flex-row items-center justify-between"><Text className="text-sm font-semibold">{t('pane.liveOutput')}</Text><IconButton icon={RefreshCw} accessibilityLabel={t('pane.refreshOutput')} className="size-[34px]" onPress={read} /></View>
          <View className="flex-1 overflow-hidden rounded-md bg-[#212121]">{output ? <AnsiOutput value={output} /> : <ActivityIndicator color={colors.acid} className="flex-1" />}</View>
          <View className="mt-2 flex-row gap-1">{[['ESC', 'esc'], ['CTRL+C', 'ctrl+c'], ['TAB', 'tab'], ['↑', 'up'], ['↓', 'down'], ['ENTER', 'enter']].map(([title, key]) => <Button className="h-[34px] flex-1 rounded-sm bg-[#2F2F2F] px-1" key={title} variant="secondary" onPress={hapticPress(() => run(() => client.sendPaneKeys(pane.pane_id, [key])))}><Text className="font-mono text-[8px] text-[#ECECEC]">{title}</Text></Button>)}</View>
          <View className="mt-2.5 min-h-[52px] flex-row items-center rounded-full border border-border bg-card py-1 pl-3.5 pr-1.5"><Input className="h-10 flex-1 border-0 bg-transparent px-0 shadow-none" value={command} onChangeText={setCommand} placeholder={t('pane.sendPlaceholder')} /><IconButton icon={ArrowUp} accessibilityLabel={t('pane.send')} disabled={!command.trim() || busy} selected={Boolean(command.trim())} onPress={() => run(async () => { await client.runInPane(pane.pane_id, command); setCommand(''); })} /></View>
          <Button className="mt-2 rounded-full" variant="destructive" onPress={hapticPress(() => Alert.alert(t('pane.closeTitle'), pane.label || pane.pane_id, [{ text: t('common.cancel'), style: 'cancel' }, { text: t('common.close'), style: 'destructive', onPress: () => run(() => client.closePane(pane.pane_id), true) }]))}><Icon as={Trash2} size={17} color="#FFFFFF" /><Text>{t('pane.closePane')}</Text></Button>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Action({ label, icon, onPress }: { label: string; icon: LucideIcon; onPress: () => void }) { const { colors: theme } = useTheme(); return <Button size="sm" variant="secondary" onPress={hapticPress(onPress)}><Icon as={icon} size={15} color={theme.text} /><Text>{label}</Text></Button>; }
