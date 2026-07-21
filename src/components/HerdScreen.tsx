import Ionicons from '@expo/vector-icons/Ionicons';
import { Plus, Sparkles } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import {
  agentsForHerdFilter,
  queuesForHerdFilter,
  type HerdHostQueue,
  type HerdQueueAgent,
} from '@/src/herdQueue';
import { statusColor, useTheme } from '@/src/theme';
import type { AgentInfo } from '@/src/types';
import { AnimatedAgentStatusGlyph, AnimatedEntrance, hapticPress, StatusBadge } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  queues: HerdHostQueue[];
  selectedHostId: string | null;
  onSelectHost: (hostId: string | null) => void;
  onRefresh: () => void;
  onOpenTerminal: (hostId: string, agent: AgentInfo) => void;
  onStart: (hostId: string, name: string, command: string, cwd: string) => Promise<void>;
  onStartServer: (hostId: string) => Promise<void>;
}

export function HerdScreen({
  queues,
  selectedHostId,
  onSelectHost,
  onRefresh,
  onOpenTerminal,
  onStart,
  onStartServer,
}: Props) {
  const { colors } = useTheme();
  const scopedQueues = queuesForHerdFilter(queues, selectedHostId);
  const selectedQueue = selectedHostId ? scopedQueues[0] : undefined;
  const queueAgents = agentsForHerdFilter(queues, selectedHostId);
  const blocked = queueAgents.filter(item => item.agent.agent_status === 'blocked').length;
  const working = queueAgents.filter(item => item.agent.agent_status === 'working').length;
  const done = queueAgents.filter(item => item.agent.agent_status === 'done').length;
  const refreshing = scopedQueues.some(queue => queue.refreshing);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('agent');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');

  const selectHost = (hostId: string | null) => {
    setCreating(false);
    onSelectHost(hostId);
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
    <ScrollView
      className="flex-1 bg-background"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} colors={[colors.text]} />}
    >
      <View className="p-4 pb-8">
        <View className="mb-6">
          <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">Queue scope</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-1">
            <ScopeButton selected={selectedHostId === null} label="All hosts" onPress={() => selectHost(null)} />
            {queues.map(queue => (
              <ScopeButton
                key={queue.id}
                selected={selectedHostId === queue.id}
                label={queue.label}
                onPress={() => selectHost(queue.id)}
              />
            ))}
          </ScrollView>
          <Text className="mt-3 px-1 text-xs leading-[17px] text-muted-foreground">
            {selectedQueue ? selectedQueue.address : `${hostCountLabel} · merged queue`}
          </Text>
        </View>

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
                <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{selectedQueue ? `Start an agent on ${selectedQueue.label}, then pull down to refresh.` : 'No agents are active across the merged host queue.'}</Text>
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
  );
}

function ScopeButton({ selected, label, onPress }: { selected: boolean; label: string; onPress: () => void }) {
  return (
    <Button
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      className="rounded-full px-4"
      size="sm"
      variant={selected ? 'default' : 'outline'}
      onPress={hapticPress(onPress)}
    >
      <Text>{label}</Text>
    </Button>
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
        <View className="min-w-0 flex-1"><View className="flex-row items-center gap-2"><Text className="flex-1 text-base font-semibold" numberOfLines={1}>{item.primaryLabel}</Text><StatusBadge agentStatus status={agent.agent_status} label={stateLabel} /></View><Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{agent.title || agent.foreground_cwd || agent.cwd || 'Untitled task'}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70" numberOfLines={1}>{context}</Text></View>
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
