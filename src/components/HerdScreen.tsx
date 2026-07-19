import Ionicons from '@expo/vector-icons/Ionicons';
import { Plus, Sparkles } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { tabNameForAgent } from '@/src/lib/agentStatusEvents';
import { statusColor, useTheme } from '@/src/theme';
import type { AgentInfo, TabInfo } from '@/src/types';
import { hapticPress, StatusBadge } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  agents: AgentInfo[];
  tabs: TabInfo[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpenTerminal: (agent: AgentInfo) => void;
  onStart: (name: string, command: string, cwd: string) => Promise<void>;
}

export function HerdScreen({ agents, tabs, refreshing, onRefresh, onOpenTerminal, onStart }: Props) {
  const { colors } = useTheme();
  const blocked = agents.filter(agent => agent.agent_status === 'blocked').length;
  const working = agents.filter(agent => agent.agent_status === 'working').length;
  const done = agents.filter(agent => agent.agent_status === 'done').length;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('agent');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');

  const start = async () => {
    if (!name.trim() || !command.trim()) return;
    await onStart(name, command, cwd);
    setCommand('');
    setCreating(false);
  };

  const sorted = [...agents].sort((a, b) => priority(a.agent_status) - priority(b.agent_status));
  return (
    <ScrollView className="flex-1 bg-background" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} colors={[colors.text]} />}>
      <View className="p-4 pb-8">
        <View className="mb-6 flex-row">
          <Metric value={agents.length} label="Agents" />
          <Metric value={working} label="Working" status="working" />
          <Metric value={blocked} label="Need you" status="blocked" />
          <Metric value={done} label="Done" status="done" />
        </View>

        <View className="min-h-10 flex-row items-center justify-between">
          <Text className="px-1 text-sm font-semibold text-muted-foreground">Attention queue</Text>
          <Button size="sm" variant="ghost" onPress={hapticPress(() => setCreating(value => !value))}>
            {creating ? <Ionicons name="close" size={16} color={colors.text} /> : <Icon as={Plus} size={16} />}
            <Text>{creating ? 'Close' : 'Start agent'}</Text>
          </Button>
        </View>

        {creating ? (
          <View className="mb-4 gap-2.5 rounded-lg border border-border bg-card p-3.5">
            <Text className="mb-0.5 text-[17px] font-semibold leading-[22px]">Start an agent</Text>
            <Input value={name} onChangeText={setName} placeholder="Agent name" />
            <Input value={command} onChangeText={setCommand} placeholder="Command, e.g. claude" autoCapitalize="none" />
            <Input value={cwd} onChangeText={setCwd} placeholder="Working directory (optional)" autoCapitalize="none" />
            <View className="mt-0.5 flex-row justify-end gap-2"><Button size="sm" variant="ghost" onPress={hapticPress(() => setCreating(false))}><Text>Cancel</Text></Button><Button size="sm" disabled={!name.trim() || !command.trim()} onPress={hapticPress(start)}><Text>Launch</Text></Button></View>
          </View>
        ) : null}

        {sorted.length === 0 ? (
          <View className="min-h-[360px] items-center justify-center p-7">
            <View className="size-16 items-center justify-center rounded-full bg-muted"><Icon as={Sparkles} size={28} /></View>
            <Text className="mt-[18px] text-xl font-semibold leading-[26px]">No agents detected</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">Start an agent in a pane, then pull down to refresh.</Text>
          </View>
        ) : (
          <View className="border-y border-border">
            {sorted.map((agent, index) => {
              const tabLabel = tabNameForAgent(agent, tabs);
              const agentLabel = agent.display_agent || agent.name || agent.agent || 'agent';
              const stateLabel = agent.state_labels?.[agent.agent_status] || agent.custom_status || agent.agent_status;
              const tone = statusColor(agent.agent_status, colors);
              return (
                <Button accessibilityLabel={`Open ${tabLabel} terminal`} className={index > 0 ? 'h-auto min-h-[92px] w-full justify-start gap-3 rounded-none border-t border-border px-0 py-[13px]' : 'h-auto min-h-[92px] w-full justify-start gap-3 rounded-none px-0 py-[13px]'} key={agent.terminal_id} variant="ghost" onPress={hapticPress(() => onOpenTerminal(agent))}>
                  <View className="size-10 items-center justify-center rounded-full" style={{ backgroundColor: `${tone}1F` }}><Ionicons name="sparkles" size={18} color={tone} /></View>
                  <View className="min-w-0 flex-1"><View className="flex-row items-center gap-2"><Text className="flex-1 text-base font-semibold" numberOfLines={1}>{tabLabel}</Text><StatusBadge status={agent.agent_status} label={stateLabel} /></View><Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{agent.title || agent.foreground_cwd || agent.cwd || 'Untitled task'}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70" numberOfLines={1}>{agentLabel} · {agent.workspace_id} · {agent.pane_id}{agent.focused ? ' · Focused' : ''}</Text></View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                </Button>
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function Metric({ value, label, status }: { value: number; label: string; status?: string }) {
  const { colors } = useTheme();
  return <View className="flex-1"><Text className="text-2xl font-semibold leading-[30px]" style={status ? { color: statusColor(status, colors) } : undefined}>{value}</Text><Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground">{label}</Text></View>;
}

function priority(status: string): number {
  return ({ blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 } as Record<string, number>)[status] ?? 5;
}
