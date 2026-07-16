import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import type { AppTab } from '../types';

interface Props {
  activeTab: AppTab;
  sessionCount: number;
  onSelect: (tab: AppTab) => void;
}

const TABS: { id: AppTab; symbol: string; label: string }[] = [
  { id: 'hosts', symbol: '▤', label: 'HOSTS' },
  { id: 'herd', symbol: '●', label: 'HERD' },
  { id: 'terminal', symbol: '>_', label: 'TERMINAL' },
  { id: 'more', symbol: '☰', label: 'MORE' },
];

export function BottomNavigation({ activeTab, sessionCount, onSelect }: Props) {
  return (
    <View style={styles.bar}>
      {TABS.map(tab => {
        const active = tab.id === activeTab;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            onPress={() => onSelect(tab.id)}
            style={[styles.item, active && styles.itemActive]}>
            <View style={styles.symbolWrap}>
              <Text style={[styles.symbol, active && styles.activeText]}>{tab.symbol}</Text>
              {tab.id === 'terminal' && sessionCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{sessionCount}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, active && styles.activeText]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { height: 62, flexDirection: 'row', backgroundColor: colors.panel, borderTopColor: colors.line, borderTopWidth: 1 },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, borderTopColor: 'transparent', borderTopWidth: 2 },
  itemActive: { borderTopColor: colors.acid, backgroundColor: '#171c16' },
  symbolWrap: { position: 'relative', minWidth: 24, alignItems: 'center' },
  symbol: { color: colors.muted, fontFamily: 'monospace', fontSize: 14, fontWeight: '700' },
  label: { color: colors.muted, fontFamily: 'monospace', fontSize: 7, letterSpacing: 0.7 },
  activeText: { color: colors.acid },
  badge: { position: 'absolute', top: -7, right: -9, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.acid },
  badgeText: { color: colors.ink, fontFamily: 'monospace', fontSize: 8, fontWeight: '900' },
});
