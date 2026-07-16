import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

export interface LiveSessionRailItem {
  hostId: string;
  label: string;
  status: 'connecting' | 'connected' | 'reconnecting' | 'error';
  terminalCount: number;
}

interface Props {
  sessions: LiveSessionRailItem[];
  activeHostId: string | null;
  onExit: () => void;
  onSelect: (hostId: string) => void;
  onClose: (hostId: string) => void;
  onNew: () => void;
}

export function LiveSessionRail({ sessions, activeHostId, onExit, onSelect, onClose, onNew }: Props) {
  return (
    <View style={styles.bar}>
      <Pressable accessibilityLabel="Leave terminals" onPress={onExit} style={styles.exit}>
        <Text style={styles.exitText}>‹</Text>
      </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.rail}>
        {sessions.map(session => {
          const active = session.hostId === activeHostId;
          return (
            <View key={session.hostId} style={[styles.chip, active && styles.chipActive]}>
              <Pressable accessibilityLabel={`Open ${session.label} session`} onPress={() => onSelect(session.hostId)} style={styles.chipMain}>
                <View style={[styles.dot, { backgroundColor: statusColor(session.status) }]} />
                <Text numberOfLines={1} style={[styles.label, active && styles.labelActive]}>{session.label}</Text>
                {session.terminalCount > 0 && <Text style={[styles.count, active && styles.labelActive]}>{session.terminalCount}</Text>}
              </Pressable>
              <Pressable accessibilityLabel={`Disconnect ${session.label}`} hitSlop={8} onPress={() => onClose(session.hostId)} style={styles.close}>
                <Text style={[styles.closeText, active && styles.labelActive]}>×</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
      <Pressable accessibilityLabel="New host session" onPress={onNew} style={styles.newSession}>
        <Text style={styles.newText}>＋</Text>
      </Pressable>
    </View>
  );
}

function statusColor(status: LiveSessionRailItem['status']): string {
  if (status === 'connected') return colors.done;
  if (status === 'connecting' || status === 'reconnecting') return colors.working;
  return colors.blocked;
}

const styles = StyleSheet.create({
  bar: { height: 44, flexDirection: 'row', alignItems: 'stretch', backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: 1 },
  exit: { width: 42, alignItems: 'center', justifyContent: 'center' },
  exitText: { color: colors.text, fontSize: 30, fontWeight: '300', marginTop: -3 },
  scroll: { flex: 1, minWidth: 0 },
  rail: { alignItems: 'center', paddingHorizontal: 4, gap: 6 },
  chip: { maxWidth: 190, height: 29, flexDirection: 'row', alignItems: 'center', borderRadius: 15, backgroundColor: colors.panelRaised, borderColor: colors.line, borderWidth: 1, overflow: 'hidden' },
  chipActive: { backgroundColor: colors.acid, borderColor: colors.acid },
  chipMain: { minWidth: 0, flexShrink: 1, height: 29, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10, paddingRight: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { color: colors.text, fontSize: 10, fontWeight: '800', maxWidth: 125 },
  labelActive: { color: colors.ink },
  count: { color: colors.muted, fontFamily: 'monospace', fontSize: 8 },
  close: { width: 25, height: 29, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: colors.muted, fontSize: 16, lineHeight: 18 },
  newSession: { width: 44, alignItems: 'center', justifyContent: 'center', borderLeftColor: colors.line, borderLeftWidth: 1 },
  newText: { color: colors.acid, fontSize: 24, lineHeight: 26 },
});
