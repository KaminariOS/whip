import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radii, spacing, useTheme } from '../theme';
import type { IconName } from './ui';
import { ScreenHeader, SectionLabel } from './ui';

interface Props {
  connectedHost: string | null;
  onOpenSettings: () => void;
}

export function MoreScreen({ connectedHost, onOpenSettings }: Props) {
  const { colors } = useTheme();
  return (
    <View style={[styles.page, { backgroundColor: colors.canvas }]}>
      <ScreenHeader title="More" subtitle={connectedHost ? `Connected to ${connectedHost}` : 'Device and connection options'} />
      <View style={styles.content}>
        <SectionLabel>Preferences</SectionLabel>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.divider }]}>
          <MoreRow icon="settings-outline" title="Settings" copy="Notifications, speech, terminal and connection preferences" onPress={onOpenSettings} />
        </View>
        <Text style={[styles.version, { color: colors.textTertiary }]}>Herdr Remote · Android client</Text>
      </View>
    </View>
  );
}

function MoreRow({ icon, title, copy, onPress }: { icon: IconName; title: string; copy: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.65 }]}>
      <View style={[styles.rowIcon, { backgroundColor: colors.surfaceRaised }]}><Ionicons name={icon} size={20} color={colors.text} /></View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.rowCopy, { color: colors.textSecondary }]}>{copy}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { flex: 1, padding: spacing.lg },
  group: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  rowCopy: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  version: { marginTop: 18, fontSize: 12, lineHeight: 16, textAlign: 'center' },
});
