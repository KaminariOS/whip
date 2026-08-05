import { ChevronRight, Plus, Sparkles, SquareTerminal, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, PanResponder, RefreshControl, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  agentsForHerdFilter,
  orderByAgentStatusPriority,
  queuesForHerdFilter,
  resolveHerdWorkspaceFilter,
  type HerdHostQueue,
  type HerdQueueAgent,
} from '@/src/herdQueue';
import { cacheTierColor, cacheTierFromTokens } from '@/src/lib/cacheTtl';
import {
  HERD_TAB_MAX_DRAG,
  herdTabSwipeOffset,
  shouldClaimHerdTabSwipe,
  shouldCloseHerdTabSwipe,
} from '@/src/lib/herdTabSwipeActions';
import { statusColor, useTheme } from '@/src/theme';
import type { AgentInfo, WorkspaceInfo } from '@/src/types';
import { AnimatedAgentStatusGlyph, AnimatedEntrance, hapticPress, StatusBadge } from './app-ui';
import { CacheBadge } from './ui/CacheBadge';
import { LiveSessionRail, type LiveSessionRailItem } from './LiveSessionRail';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { WorkspaceRail } from './WorkspaceRail';

const HERD_AGENT_ROW_HEIGHT = 92;

interface Props {
  queues: HerdHostQueue[];
  sessions: LiveSessionRailItem[];
  selectedHostId: string | null;
  workspaceFilterId: string | null;
  agentCommand: string;
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
  onOpenSpace,
  onStartServer,
  onOpenSshShell,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const scopedQueues = queuesForHerdFilter(queues, selectedHostId);
  const selectedQueue = selectedHostId ? scopedQueues[0] : undefined;
  const selectedWorkspaceId = resolveHerdWorkspaceFilter(selectedQueue, workspaceFilterId);
  const selectedWorkspace = selectedQueue?.workspaces.find(
    workspace => workspace.workspace_id === selectedWorkspaceId,
  );
  const queueAgents = agentsForHerdFilter(queues, selectedHostId, selectedWorkspaceId);
  const blocked = queueAgents.filter(item => item.agent.agent_status === 'blocked').length;
  const working = queueAgents.filter(item => item.agent.agent_status === 'working').length;
  const done = queueAgents.filter(item => item.agent.agent_status === 'done').length;
  const refreshing = scopedQueues.some(queue => queue.refreshing);
  const [workspaceEditorMode, setWorkspaceEditorMode] = useState<'create' | 'rename' | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceCwd, setWorkspaceCwd] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [closingTabKey, setClosingTabKey] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceFilterId && !selectedWorkspaceId && selectedQueue) {
      onWorkspaceFilterChange(selectedQueue.id, null);
    }
  }, [onWorkspaceFilterChange, selectedQueue, selectedWorkspaceId, workspaceFilterId]);

  const selectHost = (hostId: string | null) => {
    setWorkspaceEditorMode(null);
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
    if (!selectedQueue || !selectedWorkspace || queueAgents.length > 0 || !agentCommand.trim()) return;
    await runWorkspaceAction(() => onStartAgent(
      selectedQueue.id,
      selectedWorkspace.workspace_id,
      agentCommand.trim(),
    ));
  };

  const closeTab = async (item: HerdQueueAgent): Promise<boolean> => {
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
  };

  const sorted = orderByAgentStatusPriority(
    queueAgents,
    item => item.agent.agent_status,
    item => item.agent.state_change_seq,
  );
  const visibleSorted = sorted.filter(
    item => closingTabKey !== `${item.hostId}:${item.agent.tab_id}`,
  );
  const hostCountLabel = t('herd.hostCount', { count: queues.length });

  return (
    <View className="flex-1 bg-background">
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
        <View className="flex-row items-center gap-1.5 border-b border-border bg-card p-[7px]">
          <Text className="font-mono text-[8px] text-foreground">{workspaceEditorMode === 'rename' ? t('herd.rename') : t('herd.new')} {t('herd.space')}</Text>
          <Input autoFocus selectTextOnFocus={workspaceEditorMode === 'rename'} className="h-[34px] min-w-[110px] flex-1 rounded-none px-2 font-mono text-[10px]" value={workspaceName} onChangeText={setWorkspaceName} placeholder={t('herd.labelOptional')} placeholderTextColor={colors.textTertiary} />
          {workspaceEditorMode === 'create' ? (
            <Input className="h-[34px] min-w-[110px] flex-1 rounded-none px-2 font-mono text-[10px]" value={workspaceCwd} onChangeText={setWorkspaceCwd} placeholder={t('herd.workingDirectoryOptional')} placeholderTextColor={colors.textTertiary} autoCapitalize="none" />
          ) : null}
          <Button className="h-[34px] rounded-none px-2" variant="ghost" onPress={hapticPress(() => setWorkspaceEditorMode(null))}><Text className="font-mono text-[8px] text-muted-foreground">{t('common.cancel')}</Text></Button>
          <Button className="h-[34px] rounded-none px-2" disabled={workspaceBusy} onPress={hapticPress(saveWorkspace)}><Text className="font-mono text-[8px] font-black">{t('common.save')}</Text></Button>
        </View>
      ) : null}

      <ScrollView
        className="flex-1 bg-background"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} colors={[colors.text]} />}
      >
        <View className="p-4 pb-8">
          {!selectedQueue ? (
            <Text className="mb-6 px-1 text-xs leading-[17px] text-muted-foreground">
              {t('herd.mergedQueue', { hosts: hostCountLabel })}
            </Text>
          ) : null}

        {selectedQueue && !selectedQueue.running ? (
          <View className="min-h-[360px] items-center justify-center p-7">
            <View className="size-16 items-center justify-center rounded-full bg-destructive/10"><Text className="text-[28px] font-bold text-destructive">!</Text></View>
            <Text className="mt-[18px] text-xl font-semibold leading-[26px]">{t('herd.serverOffline')}</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{t('herd.serverOfflineCopy', { host: selectedQueue.label })}</Text>
            <View className="mt-6 flex-row gap-2.5">
              <Button className="rounded-full px-5" disabled={selectedQueue.refreshing} onPress={hapticPress(() => onStartServer(selectedQueue.id))}>
                <Text>{selectedQueue.refreshing ? t('herd.starting') : t('herd.startServer')}</Text>
              </Button>
              <Button className="rounded-full px-5" variant="secondary" onPress={hapticPress(() => onOpenSshShell(selectedQueue.id))}>
                <Icon as={SquareTerminal} size={17} />
                <Text>{t('herd.openSshShell')}</Text>
              </Button>
            </View>
          </View>
        ) : (
          <>
            {selectedQueue?.running && selectedWorkspace && queueAgents.length === 0 ? (
              <View className="mb-3 flex-row justify-end gap-2">
                <Button accessibilityLabel={t('herd.startAgent')} className="rounded-full px-4" size="sm" disabled={workspaceBusy || !agentCommand.trim()} onPress={hapticPress(startAgent)}>
                  <Icon as={Plus} size={16} />
                  <Text>{t('herd.startAgent')}</Text>
                </Button>
                <Button accessibilityLabel={t('herd.openSpace')} className="rounded-full px-4" size="sm" variant="secondary" disabled={workspaceBusy} onPress={hapticPress(openSpace)}>
                  <Icon as={SquareTerminal} size={16} />
                  <Text>{t('herd.openSpace')}</Text>
                </Button>
              </View>
            ) : null}

            <View className="mb-6 flex-row">
              <Metric value={queueAgents.length} label={t('herd.agents')} />
              <Metric value={working} label={t('herd.working')} status="working" />
              <Metric value={blocked} label={t('herd.needYou')} status="blocked" />
              <Metric value={done} label={t('herd.done')} status="done" />
            </View>

            <View className="min-h-10 flex-row items-center">
              <Text className="px-1 text-sm font-semibold text-muted-foreground">{t('herd.attentionQueue')}</Text>
            </View>

            {visibleSorted.length === 0 ? (
              <View className="min-h-[360px] items-center justify-center p-7">
                <View className="size-16 items-center justify-center rounded-full bg-muted"><Icon as={Sparkles} size={28} /></View>
                <Text className="mt-[18px] text-xl font-semibold leading-[26px]">{t('herd.noAgents')}</Text>
                <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{selectedWorkspace ? t('herd.noAgentsWorkspace', { workspace: selectedWorkspace.label || selectedWorkspace.workspace_id }) : selectedQueue ? t('herd.noAgentsHost', { host: selectedQueue.label }) : t('herd.noAgentsMerged')}</Text>
              </View>
            ) : (
              <View className="border-y border-border">
                {visibleSorted.map((item, index) => (
                  <AgentRow
                    key={`${item.hostId}:${item.agent.terminal_id}`}
                    item={item}
                    index={index}
                    showHost={selectedHostId === null}
                    onOpenTerminal={onOpenTerminal}
                    closing={closingTabKey === `${item.hostId}:${item.agent.tab_id}`}
                    onCloseTab={closeTab}
                  />
                ))}
              </View>
            )}
          </>
        )}
        </View>
      </ScrollView>
    </View>
  );
}

function AgentRow({ item, index, showHost, closing, onCloseTab, onOpenTerminal }: {
  item: HerdQueueAgent;
  index: number;
  showHost: boolean;
  closing: boolean;
  onCloseTab: (item: HerdQueueAgent) => Promise<boolean>;
  onOpenTerminal: (hostId: string, agent: AgentInfo) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { agent } = item;
  const translateX = useRef(new Animated.Value(0)).current;
  const rowHeight = useRef(new Animated.Value(HERD_AGENT_ROW_HEIGHT)).current;
  const rowWidthRef = useRef(0);
  const closingRef = useRef(closing);
  const committingRef = useRef(false);
  closingRef.current = closing;
  const agentLabel = agent.display_agent || agent.name || agent.agent || 'agent';
  const stateLabel = agent.state_labels?.[agent.agent_status] || agent.custom_status || agent.agent_status;
  const tone = statusColor(agent.agent_status, colors);
  const cache = cacheTierFromTokens(agent.tokens);
  const cacheColor = cache.tier ? cacheTierColor(cache.tier, { success: colors.working, warning: colors.warning, destructive: colors.error }) : null;
  const context = [
    ...(showHost ? [item.hostLabel] : []),
    agentLabel,
    ...(agent.focused ? [t('herd.focused')] : []),
  ].join(' · ');

  const restore = () => {
    Animated.spring(translateX, {
      toValue: 0,
      damping: 24,
      stiffness: 260,
      mass: 0.8,
      overshootClamping: true,
      useNativeDriver: true,
    }).start();
  };

  const commitClose = hapticPress(() => {
    if (closingRef.current || committingRef.current) return;
    committingRef.current = true;
    Animated.parallel([
      Animated.timing(translateX, {
        toValue: -Math.max(rowWidthRef.current, HERD_TAB_MAX_DRAG),
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(rowHeight, {
        toValue: 0,
        duration: 150,
        delay: 50,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: false,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        onCloseTab(item);
        return;
      }
      committingRef.current = false;
      rowHeight.setValue(HERD_AGENT_ROW_HEIGHT);
      restore();
    });
  });

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => (
      !closingRef.current && shouldClaimHerdTabSwipe(gesture.dx, gesture.dy)
    ),
    onPanResponderGrant: () => {
      translateX.stopAnimation();
      rowHeight.stopAnimation();
    },
    onPanResponderMove: (_event, gesture) => {
      translateX.setValue(herdTabSwipeOffset(gesture.dx));
    },
    onPanResponderRelease: (_event, gesture) => {
      if (shouldCloseHerdTabSwipe(gesture.dx, gesture.vx)) commitClose();
      else restore();
    },
    onPanResponderTerminate: () => {
      if (!committingRef.current) restore();
    },
    onPanResponderTerminationRequest: () => false,
  })).current;

  return (
    <Animated.View className="overflow-hidden" style={{ height: rowHeight }}>
      <AnimatedEntrance delay={Math.min(index * 45, 225)}>
        <View
          className="relative min-h-[92px] overflow-hidden bg-destructive"
          onLayout={event => { rowWidthRef.current = event.nativeEvent.layout.width; }}>
          <View className="absolute inset-0 items-end justify-center pr-7">
            <Icon as={X} className="text-destructive-foreground" size={22} />
          </View>
          <Animated.View
            className="bg-background"
            style={{ transform: [{ translateX }] }}
            {...panResponder.panHandlers}>
            <Button
              accessibilityActions={[{ name: 'close-tab', label: t('session.closeTab', { tab: item.tabLabel }) }]}
              accessibilityLabel={t('herd.openAgentTerminal', { agent: item.primaryLabel, host: item.hostLabel })}
              className={index > 0 ? 'h-auto min-h-[92px] w-full justify-start gap-3 rounded-none border-t border-border px-0 py-[13px]' : 'h-auto min-h-[92px] w-full justify-start gap-3 rounded-none px-0 py-[13px]'}
              disabled={closing}
              variant="ghost"
              onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'close-tab') commitClose(); }}
              onPress={hapticPress(() => onOpenTerminal(item.hostId, agent))}>
              <View className="size-10 items-center justify-center rounded-full" style={{ backgroundColor: `${tone}1F` }}><AnimatedAgentStatusGlyph status={agent.agent_status} color={tone} /></View>
              <View className="min-w-0 flex-1"><View className="flex-row items-center gap-2"><Text className="flex-1 text-base font-semibold" numberOfLines={1}>{item.primaryLabel}</Text>{cache.tier && cache.label && cacheColor ? <CacheBadge label={cache.label} color={cacheColor} /> : null}<StatusBadge showIndicator={false} status={agent.agent_status} label={stateLabel} /></View><Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{agent.title || agent.foreground_cwd || agent.cwd || t('herd.untitledTask')}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70" numberOfLines={1}>{context}</Text></View>
              <Icon as={ChevronRight} size={18} color={colors.textTertiary} />
            </Button>
          </Animated.View>
        </View>
      </AnimatedEntrance>
    </Animated.View>
  );
}

function Metric({ value, label, status }: { value: number; label: string; status?: string }) {
  const { colors } = useTheme();
  return <View className="flex-1"><Text className="text-2xl font-semibold leading-[30px]" style={status ? { color: statusColor(status, colors) } : undefined}>{value}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground">{label}</Text></View>;
}
