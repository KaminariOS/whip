import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, statusColor } from '../theme';
import type { AgentInfo } from '../types';

interface Props {
  agents: AgentInfo[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpenTerminal: (agent: AgentInfo) => void;
  onStart: (name: string, command: string, cwd: string) => Promise<void>;
}

export function HerdScreen({ agents, refreshing, onRefresh, onOpenTerminal, onStart }: Props) {
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

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acid} />}>
      <View style={styles.summary}>
        <Metric value={agents.length} label="IN HERD" />
        <Metric value={working} label="RUNNING" color={colors.working} />
        <Metric value={blocked} label="NEEDS YOU" color={colors.blocked} />
        <Metric value={done} label="DONE" color={colors.done} />
      </View>

      <View style={styles.headingRow}>
        <Text style={styles.heading}>ATTENTION QUEUE</Text>
        <Pressable onPress={() => setCreating(value => !value)}><Text style={styles.startAgent}>+ START AGENT</Text></Pressable>
      </View>

      {creating && (
        <View style={styles.createPanel}>
          <TextInput value={name} onChangeText={setName} placeholder="Agent name" placeholderTextColor={colors.muted} style={styles.input} />
          <TextInput value={command} onChangeText={setCommand} placeholder="Command, e.g. claude" placeholderTextColor={colors.muted} autoCapitalize="none" style={styles.input} />
          <TextInput value={cwd} onChangeText={setCwd} placeholder="Working directory (optional)" placeholderTextColor={colors.muted} autoCapitalize="none" style={styles.input} />
          <View style={styles.createActions}>
            <Pressable onPress={() => setCreating(false)} style={styles.cancel}><Text style={styles.cancelText}>CANCEL</Text></Pressable>
            <Pressable onPress={start} style={styles.create}><Text style={styles.createText}>LAUNCH</Text></Pressable>
          </View>
        </View>
      )}

      {agents.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>NO AGENTS DETECTED</Text>
          <Text style={styles.emptyCopy}>Start an agent in a pane, then pull down to refresh.</Text>
        </View>
      ) : (
        [...agents]
          .sort((a, b) => priority(a.agent_status) - priority(b.agent_status))
          .map((agent, index) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${agent.display_agent || agent.name || agent.agent || 'agent'} terminal`}
              key={agent.terminal_id}
              onPress={() => onOpenTerminal(agent)}
              style={styles.agentCard}>
              <View style={styles.agentIndex}>
                <Text style={styles.indexText}>{String(index + 1).padStart(2, '0')}</Text>
              </View>
              <View style={styles.agentBody}>
                <View style={styles.agentTop}>
                  <Text numberOfLines={1} style={styles.agentName}>
                    {agent.display_agent || agent.name || agent.agent || 'agent'}
                  </Text>
                  <View style={[styles.statusPill, { borderColor: statusColor(agent.agent_status) }]}>
                    <View style={[styles.statusDot, { backgroundColor: statusColor(agent.agent_status) }]} />
                    <Text style={[styles.statusText, { color: statusColor(agent.agent_status) }]}>
                      {agent.state_labels?.[agent.agent_status] || agent.custom_status || agent.agent_status}
                    </Text>
                  </View>
                </View>
                <Text numberOfLines={1} style={styles.agentTitle}>
                  {agent.title || agent.foreground_cwd || agent.cwd || 'Untitled task'}
                </Text>
                <Text style={styles.agentMeta}>
                  {agent.workspace_id} / {agent.pane_id} {agent.focused ? ' · FOCUSED' : ''}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))
      )}
    </ScrollView>
  );
}

function Metric({ value, label, color = colors.text }: { value: number; label: string; color?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function priority(status: string): number {
  return ({ blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 } as Record<string, number>)[status] ?? 5;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ink },
  content: { padding: 16, paddingBottom: 30 },
  summary: { flexDirection: 'row', borderColor: colors.line, borderWidth: 1, marginBottom: 24 },
  metric: { flex: 1, paddingVertical: 13, paddingHorizontal: 8, borderRightColor: colors.line, borderRightWidth: 1 },
  metricValue: { fontFamily: 'monospace', fontWeight: '900', fontSize: 22 },
  metricLabel: { color: colors.muted, fontFamily: 'monospace', fontSize: 7, marginTop: 4 },
  headingRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 9 },
  heading: { color: colors.acid, fontFamily: 'monospace', fontSize: 10, letterSpacing: 1.4 },
  startAgent: { color: colors.acid, fontFamily: 'monospace', fontSize: 8, fontWeight: '900' },
  createPanel: { borderColor: colors.acid, borderWidth: 1, backgroundColor: colors.panelRaised, padding: 10, marginBottom: 10 },
  input: { color: colors.text, backgroundColor: colors.ink, borderColor: colors.line, borderWidth: 1, padding: 9, marginBottom: 7, fontFamily: 'monospace', fontSize: 11 },
  createActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  cancel: { padding: 9 },
  cancelText: { color: colors.muted, fontFamily: 'monospace', fontSize: 8 },
  create: { backgroundColor: colors.acid, paddingHorizontal: 13, paddingVertical: 9 },
  createText: { color: colors.ink, fontFamily: 'monospace', fontSize: 8, fontWeight: '900' },
  agentCard: {
    minHeight: 92,
    backgroundColor: colors.panel,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  agentIndex: { width: 40, alignItems: 'center', paddingTop: 17 },
  indexText: { color: colors.muted, fontFamily: 'monospace', fontSize: 10 },
  agentBody: { flex: 1, paddingVertical: 14 },
  agentTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  agentName: { color: colors.text, fontSize: 16, fontWeight: '800', flex: 1 },
  statusPill: { borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusDot: { width: 5, height: 5, borderRadius: 3 },
  statusText: { fontFamily: 'monospace', fontSize: 8, textTransform: 'uppercase' },
  agentTitle: { color: colors.muted, fontSize: 12, marginTop: 8 },
  agentMeta: { color: '#697063', fontFamily: 'monospace', fontSize: 8, marginTop: 6 },
  chevron: { color: colors.acid, fontSize: 24, width: 28, alignSelf: 'center' },
  empty: { borderColor: colors.line, borderWidth: 1, borderStyle: 'dashed', padding: 26 },
  emptyTitle: { color: colors.text, fontFamily: 'monospace', fontWeight: '800' },
  emptyCopy: { color: colors.muted, lineHeight: 20, marginTop: 8 },
});
