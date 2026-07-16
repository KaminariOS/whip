import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AnsiOutput } from './AnsiOutput';
import { AgentActivityFeed } from './AgentActivityFeed';
import type { HerdrClient } from '../services/HerdrClient';
import { colors, statusColor } from '../theme';
import type { AgentInfo } from '../types';

interface Props {
  agent: AgentInfo | null;
  client: HerdrClient;
  onClose: () => void;
  onOpenTerminal: (agent: AgentInfo) => void;
  onChanged: () => void;
}

export function AgentDetail({ agent, client, onClose, onOpenTerminal, onChanged }: Props) {
  const paneId = agent?.pane_id || null;
  const loadedPaneId = useRef<string | null>(null);
  const [output, setOutput] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawOutput, setRawOutput] = useState(false);

  useEffect(() => {
    if (!paneId) {
      loadedPaneId.current = null;
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (loadedPaneId.current !== paneId) {
      loadedPaneId.current = paneId;
      setOutput('');
    }
    setError(null);
    const refreshOutput = async () => {
      try {
        const read = await client.readAgent(paneId);
        if (active) setOutput(read.text);
      } catch (reason) {
        if (active) setError(String(reason));
      } finally {
        if (active) timer = setTimeout(refreshOutput, 750);
      }
    };
    refreshOutput();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, paneId]);

  if (!agent) {
    return null;
  }

  const send = async (text: string) => {
    if (!text.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.sendAgent(agent.pane_id, text);
      setMessage('');
      const read = await client.readAgent(agent.pane_id);
      setOutput(read.text);
      onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal animationType="slide" visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerBody}>
              <Text style={styles.eyebrow}>{agent.workspace_id} / {agent.pane_id}</Text>
              <Text numberOfLines={1} style={styles.title}>
                {agent.display_agent || agent.name || agent.agent || 'Agent'}
              </Text>
            </View>
            <View style={[styles.badge, { borderColor: statusColor(agent.agent_status) }]}>
              <Text style={[styles.badgeText, { color: statusColor(agent.agent_status) }]}>
                {agent.agent_status.toUpperCase()}
              </Text>
            </View>
            <Pressable accessibilityLabel="Close" onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          <Text numberOfLines={2} style={styles.task}>{agent.title || agent.custom_status || 'No task title reported'}</Text>

          <View style={styles.context}>
            <Context label="WORKSPACE" value={agent.workspace_id} />
            <Context label="PANE" value={agent.pane_id} />
            <Context label="DIRECTORY" value={agent.foreground_cwd || agent.cwd || '—'} wide />
          </View>

          <View style={styles.outputHeader}>
            <Text style={styles.outputLabel}>{rawOutput ? 'RAW TERMINAL VIEW' : 'AGENT ACTIVITY'}</Text>
            <View style={styles.outputActions}>
              <Pressable onPress={() => setRawOutput(value => !value)}><Text style={styles.refresh}>{rawOutput ? 'GUI' : 'RAW'}</Text></Pressable>
              <Pressable onPress={() => client.readAgent(agent.pane_id).then(read => setOutput(read.text))}><Text style={styles.refresh}>REFRESH</Text></Pressable>
            </View>
          </View>
          <View style={styles.output}>
            {output
              ? rawOutput ? <AnsiOutput value={output} /> : <AgentActivityFeed value={output} />
              : <ActivityIndicator color={colors.acid} style={styles.outputSpinner} />}
          </View>

          <View style={styles.quickRow}>
            {['Continue', 'Yes', 'No'].map(value => (
              <Pressable key={value} onPress={() => send(value)} style={styles.quick}>
                <Text style={styles.quickText}>{value.toUpperCase()}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => onOpenTerminal(agent)} style={[styles.quick, styles.tui]}>
              <Text style={[styles.quickText, styles.tuiText]}>TERMINAL</Text>
            </Pressable>
          </View>

          <View style={styles.composer}>
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder="Tell this agent what to do..."
              placeholderTextColor="#70776b"
              selectionColor={colors.acid}
              multiline
              style={styles.input}
            />
            <Pressable disabled={!message.trim() || busy} onPress={() => send(message)} style={styles.send}>
              <Text style={styles.sendText}>{busy ? '…' : '↑'}</Text>
            </Pressable>
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Context({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <View style={[styles.contextItem, wide && styles.contextWide]}>
      <Text style={styles.contextLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.contextValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.ink },
  sheet: { flex: 1, backgroundColor: colors.panel, borderTopColor: colors.acid, borderTopWidth: 2, paddingHorizontal: 16, paddingTop: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerBody: { flex: 1 },
  eyebrow: { color: colors.muted, fontFamily: 'monospace', fontSize: 8 },
  title: { color: colors.text, fontSize: 24, fontWeight: '900', marginTop: 2 },
  badge: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 5 },
  badgeText: { fontFamily: 'monospace', fontSize: 9 },
  close: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: colors.text, fontSize: 28, lineHeight: 30 },
  task: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 10 },
  context: { flexDirection: 'row', flexWrap: 'wrap', borderColor: colors.line, borderWidth: 1, marginTop: 12 },
  contextItem: { width: '50%', paddingHorizontal: 9, paddingVertical: 8, borderRightColor: colors.line, borderRightWidth: 1 },
  contextWide: { width: '100%', borderTopColor: colors.line, borderTopWidth: 1, borderRightWidth: 0 },
  contextLabel: { color: colors.muted, fontFamily: 'monospace', fontSize: 7, letterSpacing: 1 },
  contextValue: { color: colors.text, fontFamily: 'monospace', fontSize: 9, marginTop: 4 },
  outputHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 18, marginBottom: 7 },
  outputLabel: { color: colors.acid, fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.2 },
  outputActions: { flexDirection: 'row', gap: 16 },
  refresh: { color: colors.muted, fontFamily: 'monospace', fontSize: 9 },
  output: { flex: 1, backgroundColor: colors.ink, borderColor: colors.line, borderWidth: 1 },
  outputSpinner: { flex: 1 },
  quickRow: { flexDirection: 'row', gap: 6, marginVertical: 10 },
  quick: { borderColor: colors.line, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 },
  quickText: { color: colors.text, fontFamily: 'monospace', fontSize: 8, fontWeight: '800' },
  tui: { marginLeft: 'auto', backgroundColor: colors.acid, borderColor: colors.acid },
  tuiText: { color: colors.ink },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderColor: colors.line, borderWidth: 1, marginBottom: 8 },
  input: { flex: 1, minHeight: 47, maxHeight: 100, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  send: { width: 48, height: 47, backgroundColor: colors.acid, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: colors.ink, fontSize: 23, fontWeight: '900' },
  error: { color: colors.blocked, fontFamily: 'monospace', fontSize: 10, marginBottom: 8 },
});
