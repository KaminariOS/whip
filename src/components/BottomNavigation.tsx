import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radii, useTheme } from '../theme';
import type { AppTab } from '../types';
import type { IconName } from './ui';

interface Props {
  activeTab: AppTab;
  sessionCount: number;
  onSelect: (tab: AppTab) => void;
}

const items: Array<{ tab: AppTab; label: string; icon: IconName; activeIcon: IconName }> = [
  { tab: 'hosts', label: 'Hosts', icon: 'server-outline', activeIcon: 'server' },
  { tab: 'herd', label: 'Herd', icon: 'people-outline', activeIcon: 'people' },
  { tab: 'terminal', label: 'Terminal', icon: 'terminal-outline', activeIcon: 'terminal' },
  { tab: 'more', label: 'More', icon: 'ellipsis-horizontal-circle-outline', activeIcon: 'ellipsis-horizontal-circle' },
];

export function BottomNavigation({ activeTab, sessionCount, onSelect }: Props) {
  const { colors } = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: colors.canvas, borderTopColor: colors.divider }]}>
      {items.map(item => {
        const active = item.tab === activeTab;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            key={item.tab}
            onPress={() => onSelect(item.tab)}
            style={({ pressed }) => [styles.item, pressed && { opacity: 0.6 }]}>
            <View style={[styles.iconWrap, active && { backgroundColor: colors.surfaceRaised }]}>
              <Ionicons name={active ? item.activeIcon : item.icon} size={20} color={active ? colors.text : colors.textSecondary} />
              {item.tab === 'terminal' && sessionCount > 0 && (
                <View style={[styles.badge, { backgroundColor: colors.primary, borderColor: colors.canvas }]}>
                  <Text style={[styles.badgeText, { color: colors.onPrimary }]}>{sessionCount > 9 ? '9+' : sessionCount}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, { color: active ? colors.text : colors.textSecondary }]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { minHeight: 66, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 5 },
  item: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 2 },
  iconWrap: { width: 44, height: 30, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 11, lineHeight: 15, fontWeight: '500' },
  badge: { position: 'absolute', top: -3, right: 2, minWidth: 17, height: 17, paddingHorizontal: 4, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 9, lineHeight: 11, fontWeight: '700' },
});
