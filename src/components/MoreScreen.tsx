import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

interface Props {
  connectedHost: string | null;
  onOpenSettings: () => void;
}

export function MoreScreen({ connectedHost, onOpenSettings }: Props) {
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title}>MORE</Text>
        <Text style={styles.subtitle}>{connectedHost ? `CONNECTED · ${connectedHost}` : 'NO ACTIVE HERDR SERVER'}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <MoreRow symbol="⚙" title="Settings" copy="Device preferences, notifications, speech, and connection controls." onPress={onOpenSettings} />
      </ScrollView>
    </View>
  );
}

function MoreRow({ symbol, title, copy, onPress }: { symbol: string; title: string; copy: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <Text style={styles.rowSymbol}>{symbol}</Text>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowCopy}>{copy}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ink },
  header: { height: 88, justifyContent: 'center', paddingHorizontal: 18, backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: 1 },
  title: { color: colors.text, fontSize: 20, fontWeight: '900', letterSpacing: 1 },
  subtitle: { color: colors.muted, fontFamily: 'monospace', fontSize: 8, letterSpacing: 0.8, marginTop: 5 },
  content: { paddingVertical: 8 },
  row: { minHeight: 78, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18 },
  rowPressed: { backgroundColor: colors.panelRaised },
  rowSymbol: { width: 42, color: colors.acid, fontSize: 19 },
  rowBody: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  rowCopy: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  chevron: { color: colors.muted, fontSize: 24, marginLeft: 12 },
});
