import Ionicons from '@expo/vector-icons/Ionicons';
import { Plus, Sparkles } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';

import {
  agentsForHerdFilter,
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
  onSelectHost: (hostId: string | null) => void;
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
  onSelectHost,
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
  const scopedQueues = queuesForHerdFilter(queues, selectedHostId);
  const selectedQueue = selectedHostId ? scopedQueues[0] : undefined;
  const [workspaceFilterId, setWorkspaceFilterId] = useState<string | null>(null);
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
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceCwd, setWorkspaceCwd] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  useEffect(() => {
    if (workspaceFilterId && !selectedWorkspaceId) setWorkspaceFilterId(null);
  }, [selectedWorkspaceId, workspaceFilterId]);

  const selectHost = (hostId: string | null) => {
    setCreating(false);
    setWorkspaceEditorMode(null);
    setWorkspaceMenuOpen(false);
    setWorkspaceFilterId(null);
    onSelectHost(hostId);
  };

  const runWorkspaceAction = async (action: () => Promise<void>): Promise<boolean> => {
    setWorkspaceBusy(true);
    try {
      await action();
      return true;
    } catch (error) {
      Alert.alert('Herdr command failed', String(error));
      return false;
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const selectWorkspace = (workspaceId: string | null) => {
    setCreating(false);
    setWorkspaceEditorMode(null);
    setWorkspaceMenuOpen(false);
    setWorkspaceFilterId(workspaceId);
    if (workspaceId && selectedQueue) {
      runWorkspaceAction(() => onSelectWorkspace(selectedQueue.id, workspaceId));
    }
  };

  const openNewWorkspace = () => {
    setWorkspaceName('');
    setWorkspaceCwd('');
    setWorkspaceMenuOpen(false);
    setWorkspaceEditorMode('create');
  };

  const openRenameWorkspace = (workspace: WorkspaceInfo | undefined = selectedWorkspace) => {
    if (!workspace) return;
    setWorkspaceFilterId(workspace.workspace_id);
    setWorkspaceName(workspace.label);
    setWorkspaceCwd('');
    setWorkspaceMenuOpen(false);
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

  const confirmCloseWorkspace = () => {
    if (!selectedQueue || !selectedWorkspace) return;
    setWorkspaceMenuOpen(false);
    Alert.alert('Close Herdr workspace?', selectedWorkspace.label || selectedWorkspace.workspace_id, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close',
        style: 'destructive',
        onPress: async () => {
          if (await runWorkspaceAction(() => onCloseWorkspace(selectedQueue.id, selectedWorkspace.workspace_id))) {
            setWorkspaceFilterId(null);
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
    priority(a.agent.agent_status) - priority(b.agent.agent_status)
  ));
  const hostCountLabel = `${queues.length} ${queues.length === 1 ? 'host' : 'hosts'}`;

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
          onActions={() => setWorkspaceMenuOpen(value => !value)}
          onRename={openRenameWorkspace}
        />
      ) : null}

      {workspaceMenuOpen && selectedQueue ? (
        <View className="min-h-[42px] flex-row items-stretch border-b border-[#424242] bg-[#181818]">
          <WorkspaceAction label="RENAME SPACE" disabled={!selectedWorkspace} onPress={() => openRenameWorkspace()} />
          <WorkspaceAction label="CLOSE SPACE" danger disabled={!selectedWorkspace} onPress={confirmCloseWorkspace} />
        </View>
      ) : null}

      {workspaceEditorMode && selectedQueue ? (
        <View className="flex-row items-center gap-1.5 border-b border-white bg-[#2F2F2F] p-[7px]">
          <Text className="font-mono text-[8px] text-white">{workspaceEditorMode === 'rename' ? 'RENAME' : 'NEW'} SPACE</Text>
          <Input className="h-[34px] min-w-[110px] flex-1 rounded-none border-[#424242] bg-[#212121] px-2 font-mono text-[10px] text-[#ECECEC]" value={workspaceName} onChangeText={setWorkspaceName} placeholder="Label (optional)" placeholderTextColor={colors.textTertiary} />
          {workspaceEditorMode === 'create' ? (
            <Input className="h-[34px] min-w-[110px] flex-1 rounded-none border-[#424242] bg-[#212121] px-2 font-mono text-[10px] text-[#ECECEC]" value={workspaceCwd} onChangeText={setWorkspaceCwd} placeholder="Working directory (optional)" placeholderTextColor={colors.textTertiary} autoCapitalize="none" />
          ) : null}
          <Button className="h-[34px] rounded-none px-2" variant="ghost" onPress={hapticPress(() => setWorkspaceEditorMode(null))}><Text className="font-mono text-[8px] text-[#B4B4B4]">CANCEL</Text></Button>
          <Button className="h-[34px] rounded-none bg-white px-2" disabled={workspaceBusy} onPress={hapticPress(saveWorkspace)}><Text className="font-mono text-[8px] font-black text-[#212121]">SAVE</Text></Button>
        </View>
      ) : null}

      <ScrollView
        className="flex-1 bg-background"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} colors={[colors.text]} />}
      >
        <View className="p-4 pb-8">
          <Text className="mb-6 px-1 text-xs leading-[17px] text-muted-foreground">
            {selectedQueue ? selectedQueue.address : `${hostCountLabel} · merged queue`}
          </Text>

        {selectedQueue && !selectedQueue.running ? (
          <View className="min-h-[360px] items-center justify-center p-7">
            <View className="size-16 items-center justify-center rounded-full bg-destructive/10"><Text className="text-[28px] font-bold text-destructive">!</Text></View>
            <Text className="mt-[18px] text-xl font-semibold leading-[26px]">Herdr server is offline</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">Start the headless runtime on {selectedQueue.label}, then refresh this queue.</Text>
            <Button className="mt-6 rounded-full px-5" disabled={selectedQueue.refreshing} onPress={hapticPress(() => onStartServer(selectedQueue.id))}>
              <Text>{selectedQueue.refreshing ? 'Starting…' : 'Start Herdr server'}</Text>
            </Button>
          </View>
        ) : (
          <>
            <View className="mb-6 flex-row">
              <Metric value={queueAgents.length} label="Agents" />
              <Metric value={working} label="Working" status="working" />
              <Metric value={blocked} label="Need you" status="blocked" />
              <Metric value={done} label="Done" status="done" />
            </View>

            <View className="min-h-10 flex-row items-center justify-between">
              <Text className="px-1 text-sm font-semibold text-muted-foreground">Attention queue</Text>
              {selectedQueue ? (
                <Button size="sm" variant="ghost" onPress={hapticPress(() => setCreating(value => !value))}>
                  {creating ? <Ionicons name="close" size={16} color={colors.text} /> : <Icon as={Plus} size={16} />}
                  <Text>{creating ? 'Close' : 'Start agent'}</Text>
                </Button>
              ) : null}
            </View>

            {creating && selectedQueue ? (
              <AnimatedEntrance className="mb-4">
                <View className="gap-2.5 rounded-lg border border-border bg-card p-3.5">
                  <Text className="mb-0.5 text-[17px] font-semibold leading-[22px]">Start an agent on {selectedQueue.label}</Text>
                  <Input value={name} onChangeText={setName} placeholder="Agent name" />
                  <Input value={command} onChangeText={setCommand} placeholder="Command, e.g. claude" autoCapitalize="none" />
                  <Input value={cwd} onChangeText={setCwd} placeholder="Working directory (optional)" autoCapitalize="none" />
                  <View className="mt-0.5 flex-row justify-end gap-2"><Button size="sm" variant="ghost" onPress={hapticPress(() => setCreating(false))}><Text>Cancel</Text></Button><Button size="sm" disabled={!name.trim() || !command.trim()} onPress={hapticPress(start)}><Text>Launch</Text></Button></View>
                </View>
              </AnimatedEntrance>
            ) : null}

            {sorted.length === 0 ? (
              <View className="min-h-[360px] items-center justify-center p-7">
                <View className="size-16 items-center justify-center rounded-full bg-muted"><Icon as={Sparkles} size={28} /></View>
                <Text className="mt-[18px] text-xl font-semibold leading-[26px]">No agents detected</Text>
                <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{selectedWorkspace ? `No agents are active in ${selectedWorkspace.label || selectedWorkspace.workspace_id}.` : selectedQueue ? `Start an agent on ${selectedQueue.label}, then pull down to refresh.` : 'No agents are active across the merged host queue.'}</Text>
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
  const { agent } = item;
  const agentLabel = agent.display_agent || agent.name || agent.agent || 'agent';
  const stateLabel = agent.state_labels?.[agent.agent_status] || agent.custom_status || agent.agent_status;
  const tone = statusColor(agent.agent_status, colors);
  const context = [
    ...(showHost ? [item.hostLabel] : []),
    agentLabel,
    ...(agent.focused ? ['Focused'] : []),
  ].join(' · ');
  return (
    <AnimatedEntrance delay={Math.min(index * 45, 225)}>
      <Button accessibilityLabel={`Open ${item.primaryLabel} terminal on ${item.hostLabel}`} className={index > 0 ? 'h-auto min-h-[92px] w-full justify-start gap-3 rounded-none border-t border-border px-0 py-[13px]' : 'h-auto min-h-[92px] w-full justify-start gap-3 rounded-none px-0 py-[13px]'} variant="ghost" onPress={hapticPress(() => onOpenTerminal(item.hostId, agent))}>
        <View className="size-10 items-center justify-center rounded-full" style={{ backgroundColor: `${tone}1F` }}><AnimatedAgentStatusGlyph status={agent.agent_status} color={tone} /></View>
        <View className="min-w-0 flex-1"><View className="flex-row items-center gap-2"><Text className="flex-1 text-base font-semibold" numberOfLines={1}>{item.primaryLabel}</Text><StatusBadge showIndicator={false} status={agent.agent_status} label={stateLabel} /></View><Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{agent.title || agent.foreground_cwd || agent.cwd || 'Untitled task'}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70" numberOfLines={1}>{context}</Text></View>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </Button>
    </AnimatedEntrance>
  );
}

function Metric({ value, label, status }: { value: number; label: string; status?: string }) {
  const { colors } = useTheme();
  return <View className="flex-1"><Text className="text-2xl font-semibold leading-[30px]" style={status ? { color: statusColor(status, colors) } : undefined}>{value}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground">{label}</Text></View>;
}

function priority(status: string): number {
  return ({ blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 } as Record<string, number>)[status] ?? 5;
}

function WorkspaceAction({ label, onPress, disabled = false, danger = false }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Button className="h-auto min-w-0 flex-1 rounded-none border-r border-[#424242] px-1" disabled={disabled} variant="ghost" onPress={hapticPress(onPress)}><Text className={danger ? 'text-center text-[9px] font-semibold text-[#FF6B6B]' : 'text-center text-[9px] font-semibold text-[#ECECEC]'}>{label}</Text></Button>
  );
}
