import {
  ChevronRight,
  History,
  Play,
  Plus,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  agentsForHerdFilter,
  orderByAgentStatusPriority,
  queuesForHerdFilter,
  resolveHerdWorkspaceFilter,
  type HerdHostQueue,
  type HerdQueueAgent,
} from '@/src/herdQueue';
import {
  HERD_TAB_MAX_DRAG,
  herdTabSwipeOffset,
  shouldClaimHerdTabSwipe,
  shouldCloseHerdTabSwipe,
} from '@/src/lib/herdTabSwipeActions';
import { terminalFontFamily } from '@/src/lib/terminalFonts';
import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, statusColor, useTheme } from '@/src/theme';
import type { AgentInfo, WorkspaceInfo } from '@/src/types';
import { AnimatedAgentStatusGlyph, AnimatedEntrance, hapticPress, StatusBadge } from './app-ui';
import { GlassBackdrop, GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { LiveSessionRail, type LiveSessionRailItem } from './LiveSessionRail';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { WorkspaceRail } from './WorkspaceRail';

const HERD_AGENT_ROW_MIN_HEIGHT = 92;

interface Props {
  queues: HerdHostQueue[];
  sessions: LiveSessionRailItem[];
  selectedHostId: string | null;
  workspaceFilterId: string | null;
  agentCommand: string;
  commandHistory: readonly string[];
  onSelectHost: (hostId: string | null) => void;
  onWorkspaceFilterChange: (hostId: string, workspaceId: string | null) => void;
  onCloseHost: (hostId: string) => void;
  onNewHost: () => void;
  onSelectWorkspace: (hostId: string, workspaceId: string) => Promise<void>;
  onCreateWorkspace: (hostId: string, name: string, cwd: string) => Promise<void>;
  onRenameWorkspace: (hostId: string, workspaceId: string, name: string) => Promise<void>;
  onCloseWorkspace: (hostId: string, workspaceId: string) => Promise<void>;
  onCloseTab: (hostId: string, tabId: string) => Promise<void>;
  onRefresh: () => void;
  onOpenTerminal: (hostId: string, agent: AgentInfo) => void;
  onStartAgent: (hostId: string, workspaceId: string, command: string) => Promise<void>;
  onRunCommand: (hostId: string, workspaceId: string, command: string) => Promise<void>;
  onOpenSpace: (hostId: string, workspaceId: string) => Promise<void>;
  onStartServer: (hostId: string) => Promise<void>;
  onOpenSshShell: (hostId: string) => void;
}

export function HerdScreen({
  queues,
  sessions,
  selectedHostId,
  workspaceFilterId,
  agentCommand,
  commandHistory,
  onSelectHost,
  onWorkspaceFilterChange,
  onCloseHost,
  onNewHost,
  onSelectWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onCloseWorkspace,
  onCloseTab,
  onRefresh,
  onOpenTerminal,
  onStartAgent,
  onRunCommand,
  onOpenSpace,
  onStartServer,
  onOpenSshShell,
}: Props) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const scopedQueues = queuesForHerdFilter(queues, selectedHostId);
  const selectedQueue = selectedHostId ? scopedQueues[0] : undefined;
  const selectedWorkspaceId = resolveHerdWorkspaceFilter(selectedQueue, workspaceFilterId);
  const selectedWorkspace = selectedQueue?.workspaces.find(
    workspace => workspace.workspace_id === selectedWorkspaceId,
  );
  const queueAgents = useMemo(
    () => agentsForHerdFilter(queues, selectedHostId, selectedWorkspaceId),
    [queues, selectedHostId, selectedWorkspaceId],
  );
  const blocked = queueAgents.filter(
    item => item.agent.agent_status === 'blocked',
  ).length;
  const working = queueAgents.filter(
    item => item.agent.agent_status === 'working',
  ).length;
  const done = queueAgents.filter(
    item => item.agent.agent_status === 'done',
  ).length;
  const refreshing = scopedQueues.some(queue => queue.refreshing);
  const [workspaceEditorMode, setWorkspaceEditorMode] = useState<'create' | 'rename' | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceCwd, setWorkspaceCwd] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [closingTabKey, setClosingTabKey] = useState<string | null>(null);
  const [commandRunnerOpen, setCommandRunnerOpen] = useState(false);
  const [commandDraft, setCommandDraft] = useState('');
  const [commandKeyboardInset, setCommandKeyboardInset] = useState(0);
  const commandComposerRef = useRef<View | null>(null);

  useEffect(() => {
    if (workspaceFilterId && !selectedWorkspaceId && selectedQueue) {
      onWorkspaceFilterChange(selectedQueue.id, null);
    }
  }, [onWorkspaceFilterChange, selectedQueue, selectedWorkspaceId, workspaceFilterId]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    let insetTimer: ReturnType<typeof setTimeout> | null = null;
    const show = Keyboard.addListener('keyboardDidShow', event => {
      if (insetTimer) clearTimeout(insetTimer);
      setCommandKeyboardInset(0);
      insetTimer = setTimeout(() => {
        const keyboardTop = event.endCoordinates.screenY;
        commandComposerRef.current?.measureInWindow((_x, y, _width, height) => {
          setCommandKeyboardInset(Math.max(0, Math.ceil(y + height - keyboardTop)));
        });
      }, 50);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      if (insetTimer) clearTimeout(insetTimer);
      insetTimer = null;
      setCommandKeyboardInset(0);
    });
    return () => {
      if (insetTimer) clearTimeout(insetTimer);
      show.remove();
      hide.remove();
    };
  }, []);

  const selectHost = (hostId: string | null) => {
    setWorkspaceEditorMode(null);
    setCommandRunnerOpen(false);
    onSelectHost(hostId);
  };

  const runWorkspaceAction = async (action: () => Promise<void>): Promise<boolean> => {
    setWorkspaceBusy(true);
    try {
      await action();
      return true;
    } catch (error) {
      Alert.alert(t('herd.commandFailed'), String(error));
      return false;
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const selectWorkspace = (workspaceId: string | null) => {
    setWorkspaceEditorMode(null);
    setCommandRunnerOpen(false);
    if (workspaceId && selectedQueue) {
      onWorkspaceFilterChange(selectedQueue.id, workspaceId);
      runWorkspaceAction(() => onSelectWorkspace(selectedQueue.id, workspaceId));
    } else if (selectedQueue) {
      onWorkspaceFilterChange(selectedQueue.id, null);
    }
  };

  const openNewWorkspace = () => {
    setWorkspaceName('');
    setWorkspaceCwd('');
    setWorkspaceEditorMode('create');
  };

  const openRenameWorkspace = (workspace: WorkspaceInfo | undefined = selectedWorkspace) => {
    if (!workspace) return;
    if (selectedQueue) onWorkspaceFilterChange(selectedQueue.id, workspace.workspace_id);
    setWorkspaceName(workspace.label);
    setWorkspaceCwd('');
    setWorkspaceEditorMode('rename');
  };

  const saveWorkspace = async () => {
    if (!selectedQueue) return;
    const succeeded = workspaceEditorMode === 'create'
      ? await runWorkspaceAction(() => onCreateWorkspace(selectedQueue.id, workspaceName, workspaceCwd))
      : selectedWorkspace
        ? await runWorkspaceAction(() => onRenameWorkspace(selectedQueue.id, selectedWorkspace.workspace_id, workspaceName))
        : false;
    if (!succeeded) return;
    setWorkspaceEditorMode(null);
    setWorkspaceName('');
    setWorkspaceCwd('');
  };

  const confirmCloseWorkspace = (workspace: WorkspaceInfo) => {
    if (!selectedQueue) return;
    Alert.alert(t('herd.closeWorkspaceTitle'), workspace.label || workspace.workspace_id, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.close'),
        style: 'destructive',
        onPress: async () => {
          if (await runWorkspaceAction(() => onCloseWorkspace(selectedQueue.id, workspace.workspace_id))
              && workspace.workspace_id === selectedWorkspaceId) {
            onWorkspaceFilterChange(selectedQueue.id, null);
          }
        },
      },
    ]);
  };

  const openSpace = async () => {
    if (!selectedQueue || !selectedWorkspace) return;
    await runWorkspaceAction(() => onOpenSpace(
      selectedQueue.id,
      selectedWorkspace.workspace_id,
    ));
  };

  const startAgent = async () => {
    if (!selectedQueue || !selectedWorkspace || !agentCommand.trim()) return;
    await runWorkspaceAction(() => onStartAgent(
      selectedQueue.id,
      selectedWorkspace.workspace_id,
      agentCommand.trim(),
    ));
  };

  const openCommandRunner = () => {
    setCommandDraft('');
    setCommandKeyboardInset(0);
    setCommandRunnerOpen(true);
  };

  const closeCommandRunner = () => {
    if (workspaceBusy) return;
    setCommandKeyboardInset(0);
    setCommandRunnerOpen(false);
  };

  const runCommand = async () => {
    const command = commandDraft.trim();
    if (!selectedQueue || !selectedWorkspace || !command) return;
    const succeeded = await runWorkspaceAction(() => onRunCommand(
      selectedQueue.id,
      selectedWorkspace.workspace_id,
      command,
    ));
    if (!succeeded) return;
    setCommandDraft('');
    setCommandRunnerOpen(false);
  };

  const closeTab = useCallback(
    async (item: HerdQueueAgent): Promise<boolean> => {
      const key = `${item.hostId}:${item.agent.tab_id}`;
      setClosingTabKey(key);
      try {
        await onCloseTab(item.hostId, item.agent.tab_id);
        return true;
      } catch (error) {
        Alert.alert(t('herd.commandFailed'), String(error));
        return false;
      } finally {
        setClosingTabKey(null);
      }
    },
    [onCloseTab, t],
  );

  const sorted = useMemo(
    () =>
      orderByAgentStatusPriority(
        queueAgents,
        item => item.agent.agent_status,
        item => item.agent.state_change_seq,
      ),
    [queueAgents],
  );
  const visibleSorted = useMemo(
    () =>
      sorted.filter(
        item => closingTabKey !== `${item.hostId}:${item.agent.tab_id}`,
      ),
    [closingTabKey, sorted],
  );
  const hostCountLabel = t('herd.hostCount', { count: queues.length });
  const renderAgent = useCallback(
    ({ item, index }: ListRenderItemInfo<HerdQueueAgent>) => (
      <AgentRow
        item={item}
        index={index}
        showHost={selectedHostId === null}
        showSpace={selectedWorkspaceId === null}
        onOpenTerminal={onOpenTerminal}
        closing={closingTabKey === `${item.hostId}:${item.agent.tab_id}`}
        onCloseTab={closeTab}
      />
    ),
    [closeTab, closingTabKey, onOpenTerminal, selectedHostId, selectedWorkspaceId],
  );

  return (
    <View className="flex-1">
      <LiveSessionRail sessions={sessions} activeHostId={selectedHostId} onSelect={selectHost} onClose={onCloseHost} onNew={onNewHost} />
      {selectedQueue ? (
        <WorkspaceRail
          workspaces={selectedQueue.workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          busy={workspaceBusy || !selectedQueue.running}
          onSelect={selectWorkspace}
          onNew={openNewWorkspace}
          onRename={openRenameWorkspace}
          onClose={confirmCloseWorkspace}
        />
      ) : null}

      {workspaceEditorMode && selectedQueue ? (
        <GlassSurface className="flex-row items-center gap-1.5 border-b border-white/30 p-[7px] dark:border-white/10">
          <Text className="font-mono text-[8px] text-foreground">{workspaceEditorMode === 'rename' ? t('herd.rename') : t('herd.new')} {t('herd.space')}</Text>
          <Input autoFocus selectTextOnFocus={workspaceEditorMode === 'rename'} className="h-[34px] min-w-[110px] flex-1 rounded-none px-2 font-mono text-[10px]" value={workspaceName} onChangeText={setWorkspaceName} placeholder={t('herd.labelOptional')} placeholderTextColor={colors.textTertiary} />
          {workspaceEditorMode === 'create' ? (
            <Input className="h-[34px] min-w-[110px] flex-1 rounded-none px-2 font-mono text-[10px]" value={workspaceCwd} onChangeText={setWorkspaceCwd} placeholder={t('herd.workingDirectoryOptional')} placeholderTextColor={colors.textTertiary} autoCapitalize="none" />
          ) : null}
          <Button className="h-[34px] rounded-none px-2" variant="ghost" onPress={hapticPress(() => setWorkspaceEditorMode(null))}><Text className="font-mono text-[8px] text-muted-foreground">{t('common.cancel')}</Text></Button>
          <Button className="h-[34px] rounded-none px-2" disabled={workspaceBusy} onPress={hapticPress(saveWorkspace)}><Text className="font-mono text-[8px] font-black">{t('common.save')}</Text></Button>
        </GlassSurface>
      ) : null}

      <FlatList
        className="flex-1"
        contentContainerClassName="px-4 pb-8"
        data={selectedQueue && !selectedQueue.running ? [] : visibleSorted}
        initialNumToRender={8}
        windowSize={7}
        maxToRenderPerBatch={6}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={Platform.OS === 'android'}
        keyExtractor={herdAgentKey}
        renderItem={renderAgent}
        ItemSeparatorComponent={AgentRowSeparator}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.textSecondary}
            colors={[colors.text]}
          />
        }
        ListHeaderComponent={
          <>
            {!selectedQueue ? (
              <Text className="mb-6 px-1 pt-4 text-xs leading-[17px] text-muted-foreground">
                {t('herd.mergedQueue', { hosts: hostCountLabel })}
              </Text>
            ) : null}

            {selectedQueue && !selectedQueue.running ? (
              <View className="min-h-[360px] items-center justify-center p-7">
                <View className="size-16 items-center justify-center rounded-full bg-destructive/10">
                  <Text className="text-[28px] font-bold text-destructive">
                    !
                  </Text>
                </View>
                <Text className="mt-[18px] text-xl font-semibold leading-[26px]">
                  {t('herd.serverOffline')}
                </Text>
                <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
                  {t('herd.serverOfflineCopy', { host: selectedQueue.label })}
                </Text>
                <View className="mt-6 flex-row gap-2.5">
                  <Button
                    className="rounded-full px-5"
                    disabled={selectedQueue.refreshing}
                    onPress={hapticPress(() => onStartServer(selectedQueue.id))}
                  >
                    <Text>
                      {selectedQueue.refreshing
                        ? t('herd.starting')
                        : t('herd.startServer')}
                    </Text>
                  </Button>
                  <Button
                    className="rounded-full px-5"
                    variant="secondary"
                    onPress={hapticPress(() =>
                      onOpenSshShell(selectedQueue.id),
                    )}
                  >
                    <Icon as={SquareTerminal} size={17} />
                    <Text>{t('herd.openSshShell')}</Text>
                  </Button>
                </View>
              </View>
            ) : (
              <>
                {selectedQueue?.running && selectedWorkspace ? (
                  <View className="mb-3 flex-row justify-end gap-2">
                    <Button
                      accessibilityLabel={t('herd.startAgent')}
                      className={cn('rounded-full px-4', appGlassEnabled && 'border')}
                      size="sm"
                      variant={appGlassEnabled ? 'ghost' : 'default'}
                      disabled={workspaceBusy || !agentCommand.trim()}
                      style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
                      onPress={hapticPress(startAgent)}
                    >
                      <Icon as={Plus} size={16} />
                      <Text>{t('herd.agent')}</Text>
                    </Button>
                    <Button
                      accessibilityLabel={t('herd.runCommand')}
                      className={cn('rounded-full px-4', appGlassEnabled && 'border')}
                      size="sm"
                      variant={appGlassEnabled ? 'ghost' : 'secondary'}
                      disabled={workspaceBusy}
                      style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
                      onPress={hapticPress(openCommandRunner)}
                    >
                      <Icon as={Play} size={16} />
                      <Text>{t('herd.run')}</Text>
                    </Button>
                    <Button
                      accessibilityLabel={t('herd.openSpace')}
                      className={cn('rounded-full px-4', appGlassEnabled && 'border')}
                      size="sm"
                      variant={appGlassEnabled ? 'ghost' : 'secondary'}
                      disabled={workspaceBusy}
                      style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
                      onPress={hapticPress(openSpace)}
                    >
                      <Icon as={SquareTerminal} size={16} />
                      <Text>{t('herd.open')}</Text>
                    </Button>
                  </View>
                ) : null}

                <View className="mb-6 flex-row">
                  <Metric value={queueAgents.length} label={t('herd.agents')} />
                  <Metric
                    value={working}
                    label={t('herd.working')}
                    status="working"
                  />
                  <Metric
                    value={blocked}
                    label={t('herd.needYou')}
                    status="blocked"
                  />
                  <Metric value={done} label={t('herd.done')} status="done" />
                </View>

                <View className="min-h-10 flex-row items-center">
                  <Text className="px-1 text-sm font-semibold text-muted-foreground">
                    {t('herd.attentionQueue')}
                  </Text>
                </View>
              </>
            )}
          </>
        }
        ListEmptyComponent={
          selectedQueue?.running === false ? null : (
            <View className="min-h-[360px] items-center justify-center p-7">
              <View className="size-16 items-center justify-center rounded-full bg-muted">
                <Icon as={Sparkles} size={28} />
              </View>
              <Text className="mt-[18px] text-xl font-semibold leading-[26px]">
                {t('herd.noAgents')}
              </Text>
              <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
                {selectedWorkspace
                  ? t('herd.noAgentsWorkspace', {
                      workspace:
                        selectedWorkspace.label ||
                        selectedWorkspace.workspace_id,
                    })
                  : selectedQueue
                  ? t('herd.noAgentsHost', { host: selectedQueue.label })
                  : t('herd.noAgentsMerged')}
              </Text>
            </View>
          )
        }
      />
      <Modal
        animationType="fade"
        onRequestClose={closeCommandRunner}
        statusBarTranslucent
        transparent
        visible={commandRunnerOpen}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          className="flex-1 justify-end bg-black/50">
          <Pressable
            accessibilityLabel={t('herd.closeCommandRunner')}
            className="flex-1"
            onPress={closeCommandRunner}
          />
          <View
            className="rounded-t-3xl bg-background px-4 pt-3"
            style={commandSheetStyle(bottom)}>
            <View className="mb-3 flex-row items-center">
              <View className="size-10 items-center justify-center rounded-full bg-muted">
                <Icon as={Play} size={18} />
              </View>
              <View className="min-w-0 flex-1 px-3">
                <Text className="text-[17px] font-bold">{t('herd.runCommand')}</Text>
                <Text className="text-[11px] text-muted-foreground">{t('herd.runCommandCopy')}</Text>
              </View>
              <Button
                accessibilityLabel={t('herd.closeCommandRunner')}
                className="size-10 rounded-full px-0"
                disabled={workspaceBusy}
                variant="ghost"
                onPress={closeCommandRunner}>
                <Icon as={X} size={19} />
              </Button>
            </View>

            <View
              ref={commandComposerRef}
              collapsable={false}
              className="relative z-10 flex-row items-center gap-2 bg-background"
              style={commandComposerStyle(commandKeyboardInset)}>
              <Input
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                className="h-12 min-w-0 flex-1 font-mono text-[14px]"
                editable={!workspaceBusy}
                placeholder={t('herd.commandPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                returnKeyType="go"
                value={commandDraft}
                onChangeText={setCommandDraft}
                onSubmitEditing={() => { runCommand(); }}
              />
              <Button
                accessibilityLabel={t('herd.runCommand')}
                className="size-12 rounded-full px-0"
                disabled={workspaceBusy || !commandDraft.trim()}
                onPress={hapticPress(runCommand)}>
                <Icon as={Play} size={18} />
              </Button>
            </View>

            <View className="mb-1 mt-4 flex-row items-center gap-2 px-1">
              <Icon as={History} size={15} color={colors.textSecondary} />
              <Text className="text-[12px] font-semibold text-muted-foreground">{t('herd.commandHistory')}</Text>
            </View>
            {commandHistory.length === 0 ? (
              <View className="h-20 items-center justify-center px-6">
                <Text className="text-center text-[13px] text-muted-foreground">{t('herd.commandHistoryEmpty')}</Text>
              </View>
            ) : (
              <ScrollView
                className="max-h-52"
                keyboardShouldPersistTaps="always"
                showsVerticalScrollIndicator={false}>
                {commandHistory.map((entry, index) => (
                  <Button
                    key={entry}
                    accessibilityLabel={t('herd.useCommandHistory', { command: entry })}
                    className={index > 0 ? 'min-h-11 justify-start rounded-none border-t border-border px-2.5 py-2' : 'min-h-11 justify-start rounded-none px-2.5 py-2'}
                    disabled={workspaceBusy}
                    variant="ghost"
                    onPress={hapticPress(() => setCommandDraft(entry))}>
                    <Text
                      className="flex-1 text-left font-mono text-[13px] leading-[18px]"
                      numberOfLines={2}
                      style={{ fontFamily: terminalFontFamily }}>
                      {entry}
                    </Text>
                  </Button>
                ))}
              </ScrollView>
            )}

          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function commandSheetStyle(bottomInset: number) {
  return {
    paddingBottom: Math.max(16, bottomInset),
  };
}

function commandComposerStyle(keyboardInset: number) {
  return keyboardInset > 0
    ? { transform: [{ translateY: -keyboardInset }] }
    : undefined;
}

const AgentRow = memo(
  function AgentRow({
    item,
    index,
    showHost,
    showSpace,
    closing,
    onCloseTab,
    onOpenTerminal,
  }: {
    item: HerdQueueAgent;
    index: number;
    showHost: boolean;
    showSpace: boolean;
    closing: boolean;
    onCloseTab: (item: HerdQueueAgent) => Promise<boolean>;
    onOpenTerminal: (hostId: string, agent: AgentInfo) => void;
  }) {
    const { colors } = useTheme();
    const { t } = useTranslation();
    const { agent } = item;
    const translateX = useSharedValue(0);
    const rowHeight = useSharedValue(HERD_AGENT_ROW_MIN_HEIGHT);
    const restingHeightRef = useRef(HERD_AGENT_ROW_MIN_HEIGHT);
    const rowWidthRef = useRef(0);
    const closingRef = useRef(closing);
    const committingRef = useRef(false);
    closingRef.current = closing;
    const agentLabel =
      agent.display_agent || agent.name || agent.agent || 'agent';
    const primaryLabel = showSpace ? item.primaryLabel : item.tabLabel;
    const stateLabel =
      agent.state_labels?.[agent.agent_status] ||
      agent.custom_status ||
      agent.agent_status;
    const tone = statusColor(agent.agent_status, colors);
    const context = [
      ...(showHost ? [item.hostLabel] : []),
      agentLabel,
      ...(agent.focused ? [t('herd.focused')] : []),
    ].join(' · ');

    const rowStyle = useAnimatedStyle(() => ({ height: rowHeight.value }));
    const contentStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: translateX.value }],
    }));
    const actionRevealStyle = useAnimatedStyle(() => ({
      width: Math.max(0, -translateX.value),
    }));

    const restore = () => {
      translateX.value = withSpring(0, {
        damping: 24,
        stiffness: 260,
        mass: 0.8,
        overshootClamping: true,
      });
    };

    const finishClose = (finished: boolean) => {
      if (finished) {
        onCloseTab(item);
        return;
      }
      committingRef.current = false;
      rowHeight.value = restingHeightRef.current;
      restore();
    };

    const commitClose = hapticPress(() => {
      if (closingRef.current || committingRef.current) return;
      committingRef.current = true;
      translateX.value = withTiming(
        -Math.max(rowWidthRef.current, HERD_TAB_MAX_DRAG),
        {
          duration: 180,
          easing: Easing.out(Easing.cubic),
        },
      );
      rowHeight.value = withDelay(
        50,
        withTiming(
          0,
          {
            duration: 150,
            easing: Easing.inOut(Easing.quad),
          },
          finished => {
            scheduleOnRN(finishClose, Boolean(finished));
          },
        ),
      );
    });

    const panResponder = useRef(
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          !closingRef.current &&
          shouldClaimHerdTabSwipe(gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          cancelAnimation(translateX);
          cancelAnimation(rowHeight);
        },
        onPanResponderMove: (_event, gesture) => {
          translateX.value = herdTabSwipeOffset(gesture.dx);
        },
        onPanResponderRelease: (_event, gesture) => {
          if (shouldCloseHerdTabSwipe(gesture.dx, gesture.vx)) commitClose();
          else restore();
        },
        onPanResponderTerminate: () => {
          if (!committingRef.current) restore();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    ).current;

    return (
      <Animated.View className="overflow-hidden rounded-xl" style={rowStyle}>
        <AnimatedEntrance delay={Math.min(index * 45, 225)}>
          <View
            className="relative min-h-[92px] overflow-hidden rounded-xl"
            onLayout={event => {
              const { height, width } = event.nativeEvent.layout;
              rowWidthRef.current = width;
              restingHeightRef.current = Math.max(
                HERD_AGENT_ROW_MIN_HEIGHT,
                height,
              );
              if (!committingRef.current) {
                rowHeight.value = restingHeightRef.current;
              }
            }}
          >
            <Animated.View
              className="absolute inset-y-0 right-0 overflow-hidden rounded-r-xl bg-destructive"
              style={actionRevealStyle}
            >
              <View
                className="absolute inset-y-0 right-0 items-end justify-center pr-7"
                style={{ width: HERD_TAB_MAX_DRAG }}
              >
                <Icon
                  as={X}
                  className="text-destructive-foreground"
                  size={22}
                />
              </View>
            </Animated.View>
            <Animated.View
              className="overflow-hidden rounded-xl border border-white/30 dark:border-white/10"
              style={contentStyle}
              {...panResponder.panHandlers}
            >
              <GlassBackdrop />
              <Button
                accessibilityActions={[
                  {
                    name: 'close-tab',
                    label: t('session.closeTab', { tab: item.tabLabel }),
                  },
                ]}
                accessibilityLabel={t('herd.openAgentTerminal', {
                  agent: primaryLabel,
                  host: item.hostLabel,
                })}
                className="h-auto min-h-[90px] w-full justify-start gap-3 rounded-none px-3 py-[12px]"
                disabled={closing}
                variant="ghost"
                onAccessibilityAction={event => {
                  if (event.nativeEvent.actionName === 'close-tab')
                    commitClose();
                }}
                onPress={hapticPress(() => onOpenTerminal(item.hostId, agent))}
              >
                <View
                  className="size-10 items-center justify-center rounded-full"
                  style={{ backgroundColor: `${tone}1F` }}
                >
                  <AnimatedAgentStatusGlyph
                    status={agent.agent_status}
                    color={tone}
                  />
                </View>
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text
                      className="flex-1 text-base font-semibold"
                      numberOfLines={1}
                    >
                      {primaryLabel}
                    </Text>
                    <StatusBadge
                      showIndicator={false}
                      status={agent.agent_status}
                      label={stateLabel}
                    />
                  </View>
                  <Text
                    className="mt-1 text-[13px] leading-[18px] text-muted-foreground"
                    numberOfLines={1}
                  >
                    {agent.title ||
                      agent.foreground_cwd ||
                      agent.cwd ||
                      t('herd.untitledTask')}
                  </Text>
                  <Text
                    className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70"
                    numberOfLines={1}
                  >
                    {context}
                  </Text>
                </View>
                <Icon as={ChevronRight} size={18} color={colors.textTertiary} />
              </Button>
            </Animated.View>
          </View>
        </AnimatedEntrance>
      </Animated.View>
    );
  },
  (previous, next) =>
    previous.item.agent === next.item.agent &&
    previous.item.hostId === next.item.hostId &&
    previous.item.hostLabel === next.item.hostLabel &&
    previous.item.primaryLabel === next.item.primaryLabel &&
    previous.item.tabLabel === next.item.tabLabel &&
    previous.showHost === next.showHost &&
    previous.showSpace === next.showSpace &&
    previous.closing === next.closing,
);

function herdAgentKey(item: HerdQueueAgent): string {
  return `${item.hostId}:${item.agent.terminal_id}`;
}

function AgentRowSeparator() {
  return <View className="h-2" />;
}

function Metric({ value, label, status }: { value: number; label: string; status?: string }) {
  const { colors } = useTheme();
  return <View className="flex-1"><Text className="text-2xl font-semibold leading-[30px]" style={status ? { color: statusColor(status, colors) } : undefined}>{value}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground">{label}</Text></View>;
}
