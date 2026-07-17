import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radii } from '../theme';

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
      <Pressable accessibilityLabel="Leave terminals" onPress={onExit} style={styles.iconButton}><Ionicons name="chevron-back" size={21} color={colors.text} /></Pressable>
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
              <Pressable accessibilityLabel={`Disconnect ${session.label}`} hitSlop={8} onPress={() => onClose(session.hostId)} style={styles.close}><Ionicons name="close" size={14} color={active ? colors.ink : colors.muted} /></Pressable>
            </View>
          );
        })}
      </ScrollView>
      <Pressable accessibilityLabel="New host session" onPress={onNew} style={styles.iconButton}><Ionicons name="add" size={22} color={colors.text} /></Pressable>
    </View>
  );
}

function statusColor(status: LiveSessionRailItem['status']): string {
  if (status === 'connected') return colors.done;
  if (status === 'connecting' || status === 'reconnecting') return colors.working;
  return colors.blocked;
}

const styles = StyleSheet.create({
  bar: { height: 48, flexDirection: 'row', alignItems: 'stretch', backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  iconButton: { width: 46, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1, minWidth: 0 },
  rail: { alignItems: 'center', paddingHorizontal: 4, gap: 6 },
  chip: { maxWidth: 190, height: 32, flexDirection: 'row', alignItems: 'center', borderRadius: radii.full, backgroundColor: colors.panelRaised, overflow: 'hidden' },
  chipActive: { backgroundColor: colors.text },
  chipMain: { minWidth: 0, flexShrink: 1, height: 32, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 11, paddingRight: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { color: colors.text, fontSize: 11, lineHeight: 15, fontWeight: '600', maxWidth: 125 },
  labelActive: { color: colors.ink },
  count: { color: colors.muted, fontSize: 10 },
  close: { width: 27, height: 32, alignItems: 'center', justifyContent: 'center' },
});
