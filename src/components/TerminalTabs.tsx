import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { TerminalSession } from '../terminalSessions';
import { colors } from '../theme';

interface Props {
  sessions: TerminalSession[];
  activeTerminalId: string | null;
  onSelect: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onExit: () => void;
}

export function TerminalTabs({ sessions, activeTerminalId, onSelect, onClose, onExit }: Props) {
  return (
    <View style={styles.bar}>
      <Pressable accessibilityLabel="Back to herd" onPress={onExit} style={styles.exit}>
        <Text style={styles.exitText}>‹</Text>
      </Pressable>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}>
        {sessions.map(session => {
          const active = session.terminalId === activeTerminalId;
          return (
            <View key={session.terminalId} style={[styles.tab, active && styles.tabActive]}>
              <View style={[styles.dot, active && styles.dotActive]} />
              <Pressable onPress={() => onSelect(session.terminalId)} style={styles.titleButton}>
                <Text numberOfLines={1} style={[styles.title, active && styles.titleActive]}>
                  {session.title}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={`Close ${session.title}`}
                hitSlop={8}
                onPress={() => onClose(session.terminalId)}
                style={styles.close}>
                <Text style={[styles.closeText, active && styles.closeTextActive]}>×</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 46,
    backgroundColor: colors.panel,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  exit: { width: 42, alignItems: 'center', justifyContent: 'center' },
  exitText: { color: colors.text, fontSize: 30, fontWeight: '300', marginTop: -3 },
  rail: { alignItems: 'center', paddingRight: 8, gap: 6 },
  tab: {
    maxWidth: 180,
    height: 30,
    paddingLeft: 10,
    paddingRight: 4,
    borderRadius: 15,
    backgroundColor: colors.panelRaised,
    flexDirection: 'row',
    alignItems: 'center',
  },
  tabActive: { backgroundColor: colors.acid },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.idle },
  dotActive: { backgroundColor: colors.ink },
  titleButton: { maxWidth: 122, paddingHorizontal: 7, paddingVertical: 7 },
  title: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  titleActive: { color: colors.ink },
  close: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: colors.muted, fontSize: 17, lineHeight: 19 },
  closeTextActive: { color: colors.ink },
});
