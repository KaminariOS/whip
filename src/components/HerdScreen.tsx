import { ChevronRight, Plus, Sparkles, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  agentsForHerdFilter,
  compareAgentStatusPriority,
  queuesForHerdFilter,
  resolveHerdWorkspaceFilter,
  type HerdHostQueue,
  type HerdQueueAgent,
} from '@/src/herdQueue';
import { statusColor, useTheme } from '@/src/theme';
import type { AgentInfo, WorkspaceInfo } from '@/src/types';
import { AnimatedAgentStatusGlyph, AnimatedEntrance, hapticPress, StatusBadge } from './app-ui';
import { LiveSessionRail, type LiveSessionRailItem } from './LiveSessionRail';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { WorkspaceRail } from './WorkspaceRail';

interface Props {
  queues: HerdHostQueue[];
  sessions: LiveSessionRailItem[];
  selectedHostId: string | null;
  workspaceFilterId: string | null;
  onSelectHost: (hostId: string | null) => void;
  onWorkspaceFilterChange: (hostId: string, workspaceId: string | null) => void;
  onCloseHost: (hostId: string) => void;
  onNewHost: () => void;
  onSelectWorkspace: (hostId: string, workspaceId: string) => Promise<void>;
  onCreateWorkspace: (hostId: string, name: string, cwd: string) => Promise<void>;
  onRenameWorkspace: (hostId: string, workspaceId: string, name: string) => Promise<void>;
  onCloseWorkspace: (hostId: string, workspaceId: string) => Promise<void>;
  onRefresh: () => void;
  onOpenTerminal: (hostId: string, agent: AgentInfo) => void;
  onStart: (hostId: string, name: string, command: string, cwd: string) => Promise<void>;
  onStartServer: (hostId: string) => Promise<void>;
}

export function HerdScreen({
  queues,
  sessions,
  selectedHostId,
  workspaceFilterId,
  onSelectHost,
  onWorkspaceFilterChange,
  onCloseHost,
  onNewHost,
  onSelectWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onCloseWorkspace,
  onRefresh,
  onOpenTerminal,
  onStart,
  onStartServer,
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
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('agent');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [workspaceEditorMode, setWorkspaceEditorMode] = useState<'create' | 'rename' | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceCwd, setWorkspaceCwd] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  useEffect(() => {
    if (workspaceFilterId && !selectedWorkspaceId && selectedQueue) {
      onWorkspaceFilterChange(selectedQueue.id, null);
    }
  }, [onWorkspaceFilterChange, selectedQueue, selectedWorkspaceId, workspaceFilterId]);

  const selectHost = (hostId: string | null) => {
    setCreating(false);
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
    setCreating(false);
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

  const start = async () => {
    if (!selectedQueue || !name.trim() || !command.trim()) return;
    await onStart(selectedQueue.id, name, command, cwd);
    setCommand('');
    setCreating(false);
  };

  const sorted = [...queueAgents].sort((a, b) => (
    compareAgentStatusPriority(a.agent.agent_status, b.agent.agent_status)
  ));
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
          <Text className="mb-6 px-1 text-xs leading-[17px] text-muted-foreground">
            {selectedQueue ? selectedQueue.address : t('herd.mergedQueue', { hosts: hostCountLabel })}
          </Text>

        {selectedQueue && !selectedQueue.running ? (
          <View className="min-h-[360px] items-center justify-center p-7">
            <View className="size-16 items-center justify-center rounded-full bg-destructive/10"><Text className="text-[28px] font-bold text-destructive">!</Text></View>
            <Text className="mt-[18px] text-xl font-semibold leading-[26px]">{t('herd.serverOffline')}</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{t('herd.serverOfflineCopy', { host: selectedQueue.label })}</Text>
            <Button className="mt-6 rounded-full px-5" disabled={selectedQueue.refreshing} onPress={hapticPress(() => onStartServer(selectedQueue.id))}>
              <Text>{selectedQueue.refreshing ? t('herd.starting') : t('herd.startServer')}</Text>
            </Button>
          </View>
        ) : (
          <>
            <View className="mb-6 flex-row">
              <Metric value={queueAgents.length} label={t('herd.agents')} />
              <Metric value={working} label={t('herd.working')} status="working" />
              <Metric value={blocked} label={t('herd.needYou')} status="blocked" />
              <Metric value={done} label={t('herd.done')} status="done" />
            </View>

            <View className="min-h-10 flex-row items-center justify-between">
              <Text className="px-1 text-sm font-semibold text-muted-foreground">{t('herd.attentionQueue')}</Text>
              {selectedQueue ? (
                <Button size="sm" variant="ghost" onPress={hapticPress(() => setCreating(value => !value))}>
                  {creating ? <Icon as={X} size={16} color={colors.text} /> : <Icon as={Plus} size={16} />}
                  <Text>{creating ? t('common.close') : t('herd.startAgent')}</Text>
                </Button>
              ) : null}
            </View>

            {creating && selectedQueue ? (
              <AnimatedEntrance className="mb-4">
                <View className="gap-2.5 rounded-lg border border-border bg-card p-3.5">
                  <Text className="mb-0.5 text-[17px] font-semibold leading-[22px]">{t('herd.startAgentOn', { host: selectedQueue.label })}</Text>
                  <Input value={name} onChangeText={setName} placeholder={t('herd.agentName')} />
                  <Input value={command} onChangeText={setCommand} placeholder={t('herd.commandExample')} autoCapitalize="none" />
                  <Input value={cwd} onChangeText={setCwd} placeholder={t('herd.workingDirectoryOptional')} autoCapitalize="none" />
                  <View className="mt-0.5 flex-row justify-end gap-2"><Button size="sm" variant="ghost" onPress={hapticPress(() => setCreating(false))}><Text>{t('common.cancel')}</Text></Button><Button size="sm" disabled={!name.trim() || !command.trim()} onPress={hapticPress(start)}><Text>{t('herd.launch')}</Text></Button></View>
                </View>
              </AnimatedEntrance>
            ) : null}

            {sorted.length === 0 ? (
              <View className="min-h-[360px] items-center justify-center p-7">
                <View className="size-16 items-center justify-center rounded-full bg-muted"><Icon as={Sparkles} size={28} /></View>
                <Text className="mt-[18px] text-xl font-semibold leading-[26px]">{t('herd.noAgents')}</Text>
                <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{selectedWorkspace ? t('herd.noAgentsWorkspace', { workspace: selectedWorkspace.label || selectedWorkspace.workspace_id }) : selectedQueue ? t('herd.noAgentsHost', { host: selectedQueue.label }) : t('herd.noAgentsMerged')}</Text>
              </View>
            ) : (
              <View className="border-y border-border">
                {sorted.map((item, index) => (
                  <AgentRow
                    key={`${item.hostId}:${item.agent.terminal_id}`}
                    item={item}
                    index={index}
                    showHost={selectedHostId === null}
                    onOpenTerminal={onOpenTerminal}
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

function AgentRow({ item, index, showHost, onOpenTerminal }: { item: HerdQueueAgent; index: number; showHost: boolean; onOpenTerminal: (hostId: string, agent: AgentInfo) => void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { agent } = item;
  const agentLabel = agent.display_agent || agent.name || agent.agent || 'agent';
  const stateLabel = agent.state_labels?.[agent.agent_status] || agent.custom_status || agent.agent_status;
  const tone = statusColor(agent.agent_status, colors);
  const context = [
    ...(showHost ? [item.hostLabel] : []),
    agentLabel,
    ...(agent.focused ? [t('herd.focused')] : []),
  ].join(' · ');
  return (
    <AnimatedEntrance delay={Math.min(index * 45, 225)}>
      <Button accessibilityLabel={t('herd.openAgentTerminal', { agent: item.primaryLabel, host: item.hostLabel })} className={index > 0 ? 'h-auto min-h-[92px] w-full justify-start gap-3 rounded-none border-t border-border px-0 py-[13px]' : 'h-auto min-h-[92px] w-full justify-start gap-3 rounded-none px-0 py-[13px]'} variant="ghost" onPress={hapticPress(() => onOpenTerminal(item.hostId, agent))}>
        <View className="size-10 items-center justify-center rounded-full" style={{ backgroundColor: `${tone}1F` }}><AnimatedAgentStatusGlyph status={agent.agent_status} color={tone} /></View>
        <View className="min-w-0 flex-1"><View className="flex-row items-center gap-2"><Text className="flex-1 text-base font-semibold" numberOfLines={1}>{item.primaryLabel}</Text><StatusBadge showIndicator={false} status={agent.agent_status} label={stateLabel} /></View><Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{agent.title || agent.foreground_cwd || agent.cwd || t('herd.untitledTask')}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70" numberOfLines={1}>{context}</Text></View>
        <Icon as={ChevronRight} size={18} color={colors.textTertiary} />
      </Button>
    </AnimatedEntrance>
  );
}

function Metric({ value, label, status }: { value: number; label: string; status?: string }) {
  const { colors } = useTheme();
  return <View className="flex-1"><Text className="text-2xl font-semibold leading-[30px]" style={status ? { color: statusColor(status, colors) } : undefined}>{value}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground">{label}</Text></View>;
}
