import { useMemo, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { agentActivity, type AgentActivityKind } from '../lib/agentActivity';
import { colors } from '../theme';

export function AgentActivityFeed({ value }: { value: string }) {
  const scroll = useRef<ScrollView | null>(null);
  const items = useMemo(() => agentActivity(value), [value]);
  return (
    <ScrollView
      ref={scroll}
      style={styles.scroll}
      contentContainerStyle={styles.content}
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
      {items.map(item => (
        <View key={item.id} style={[styles.item, item.kind === 'prompt' && styles.prompt, item.kind === 'question' && styles.question]}>
          <View style={[styles.mark, { backgroundColor: kindColor(item.kind) }]} />
          <View style={styles.body}>
            <Text style={[styles.kind, { color: kindColor(item.kind) }]}>{kindLabel(item.kind)}</Text>
            <Text selectable style={styles.text}>{item.text}</Text>
          </View>
        </View>
      ))}
      {items.length === 0 && <Text style={styles.empty}>Waiting for agent activity…</Text>}
    </ScrollView>
  );
}

function kindLabel(kind: AgentActivityKind): string {
  return ({ prompt: 'YOU', question: 'NEEDS INPUT', tool: 'ACTION', message: 'AGENT' })[kind];
}

function kindColor(kind: AgentActivityKind): string {
  return ({ prompt: colors.acid, question: colors.blocked, tool: colors.working, message: colors.muted })[kind];
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.ink },
  content: { padding: 10, gap: 7 },
  item: { flexDirection: 'row', backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1 },
  prompt: { backgroundColor: '#1a2115' },
  question: { borderColor: colors.blocked },
  mark: { width: 3 },
  body: { flex: 1, paddingHorizontal: 10, paddingVertical: 8 },
  kind: { fontFamily: 'monospace', fontSize: 7, fontWeight: '900', letterSpacing: 1, marginBottom: 4 },
  text: { color: colors.text, fontSize: 12, lineHeight: 17 },
  empty: { color: colors.muted, textAlign: 'center', paddingVertical: 30 },
});
