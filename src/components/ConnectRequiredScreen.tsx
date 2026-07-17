import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';
import { Button } from './ui';

export function ConnectRequiredScreen({ destination, onPickHost }: { destination: string; onPickHost: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.page, { backgroundColor: colors.canvas }]}>
      <View style={[styles.symbol, { backgroundColor: colors.surface }]}>
        <Ionicons name="server-outline" size={28} color={colors.text} />
      </View>
      <Text style={[styles.title, { color: colors.text }]}>Connect a host</Text>
      <Text style={[styles.copy, { color: colors.textSecondary }]}>Choose a saved Herdr server before opening {destination.toLowerCase()}.</Text>
      <Button label="Choose host" icon="arrow-forward" onPress={onPickHost} style={styles.button} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  symbol: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600', marginTop: 20 },
  copy: { textAlign: 'center', fontSize: 15, lineHeight: 22, marginTop: 8, maxWidth: 320 },
  button: { marginTop: 24 },
});
