import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { radii, spacing, statusColor, useTheme } from '../theme';
import type { AgentInfo } from '../types';
import { Button, Input, SectionLabel, StatusBadge } from './ui';

interface Props {
  agents: AgentInfo[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpenTerminal: (agent: AgentInfo) => void;
  onStart: (name: string, command: string, cwd: string) => Promise<void>;
}

export function HerdScreen({ agents, refreshing, onRefresh, onOpenTerminal, onStart }: Props) {
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
    <ScrollView
      style={[styles.page, { backgroundColor: colors.canvas }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} colors={[colors.text]} />}>
      <View style={styles.summary}>
        <Metric value={agents.length} label="Agents" />
        <Metric value={working} label="Working" status="working" />
        <Metric value={blocked} label="Need you" status="blocked" />
        <Metric value={done} label="Done" status="done" />
      </View>

      <View style={styles.headingRow}>
        <SectionLabel>Attention queue</SectionLabel>
        <Button label={creating ? 'Close' : 'Start agent'} icon={creating ? 'close' : 'add'} variant="ghost" compact onPress={() => setCreating(value => !value)} />
      </View>

      {creating && (
        <View style={[styles.createPanel, { backgroundColor: colors.surface, borderColor: colors.divider }]}>
          <Text style={[styles.createTitle, { color: colors.text }]}>Start an agent</Text>
          <Input value={name} onChangeText={setName} placeholder="Agent name" />
          <Input value={command} onChangeText={setCommand} placeholder="Command, e.g. claude" autoCapitalize="none" />
          <Input value={cwd} onChangeText={setCwd} placeholder="Working directory (optional)" autoCapitalize="none" />
          <View style={styles.createActions}>
            <Button label="Cancel" variant="ghost" compact onPress={() => setCreating(false)} />
            <Button label="Launch" icon="arrow-up" compact disabled={!name.trim() || !command.trim()} onPress={start} />
          </View>
        </View>
      )}

      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.surface }]}><Ionicons name="sparkles-outline" size={28} color={colors.text} /></View>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No agents detected</Text>
          <Text style={[styles.emptyCopy, { color: colors.textSecondary }]}>Start an agent in a pane, then pull down to refresh.</Text>
        </View>
      ) : (
        <View style={[styles.agentList, { borderColor: colors.divider }]}>
          {sorted.map((agent, index) => {
            const nameLabel = agent.display_agent || agent.name || agent.agent || 'agent';
            const stateLabel = agent.state_labels?.[agent.agent_status] || agent.custom_status || agent.agent_status;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${nameLabel} terminal`}
                key={agent.terminal_id}
                onPress={() => onOpenTerminal(agent)}
                style={({ pressed }) => [
                  styles.agentRow,
                  { backgroundColor: pressed ? colors.surface : colors.canvas },
                  index > 0 && { borderTopColor: colors.divider, borderTopWidth: StyleSheet.hairlineWidth },
                ]}>
                <View style={[styles.agentAvatar, { backgroundColor: `${statusColor(agent.agent_status, colors)}1F` }]}>
                  <Ionicons name="sparkles" size={18} color={statusColor(agent.agent_status, colors)} />
                </View>
                <View style={styles.agentBody}>
                  <View style={styles.agentTop}>
                    <Text numberOfLines={1} style={[styles.agentName, { color: colors.text }]}>{nameLabel}</Text>
                    <StatusBadge status={agent.agent_status} label={stateLabel} />
                  </View>
                  <Text numberOfLines={1} style={[styles.agentTitle, { color: colors.textSecondary }]}>{agent.title || agent.foreground_cwd || agent.cwd || 'Untitled task'}</Text>
                  <Text numberOfLines={1} style={[styles.agentMeta, { color: colors.textTertiary }]}>{agent.workspace_id} · {agent.pane_id}{agent.focused ? ' · Focused' : ''}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

function Metric({ value, label, status }: { value: number; label: string; status?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricValue, { color: status ? statusColor(status, colors) : colors.text }]}>{value}</Text>
      <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

function priority(status: string): number {
  return ({ blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 } as Record<string, number>)[status] ?? 5;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 32 },
  summary: { flexDirection: 'row', marginBottom: 24 },
  metric: { flex: 1 },
  metricValue: { fontSize: 24, lineHeight: 30, fontWeight: '600' },
  metricLabel: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  headingRow: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  createPanel: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10, marginBottom: 16 },
  createTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600', marginBottom: 2 },
  createActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
  agentList: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  agentRow: { minHeight: 92, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
  agentAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  agentBody: { flex: 1, minWidth: 0 },
  agentTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  agentName: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600' },
  agentTitle: { fontSize: 13, lineHeight: 18, marginTop: 5 },
  agentMeta: { fontSize: 11, lineHeight: 15, marginTop: 3 },
  empty: { minHeight: 360, alignItems: 'center', justifyContent: 'center', padding: 28 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 20, lineHeight: 26, fontWeight: '600', marginTop: 18 },
  emptyCopy: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 7 },
});
