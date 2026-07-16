import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

interface Props {
  destination: 'HERD' | 'TERMINAL';
  onPickHost: () => void;
}

export function ConnectRequiredScreen({ destination, onPickHost }: Props) {
  return (
    <View style={styles.page}>
      <Text style={styles.symbol}>{destination === 'HERD' ? '●' : '>_'}</Text>
      <Text style={styles.title}>NO ACTIVE SERVER</Text>
      <Text style={styles.copy}>Connect a saved Herdr host before opening {destination.toLowerCase()}.</Text>
      <Pressable onPress={onPickHost} style={styles.button}>
        <Text style={styles.buttonText}>PICK A HOST  →</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, backgroundColor: colors.ink },
  symbol: { color: colors.acid, fontFamily: 'monospace', fontSize: 34, fontWeight: '900' },
  title: { color: colors.text, fontFamily: 'monospace', fontSize: 15, fontWeight: '900', letterSpacing: 1, marginTop: 16 },
  copy: { color: colors.muted, textAlign: 'center', lineHeight: 19, marginTop: 9, maxWidth: 300 },
  button: { backgroundColor: colors.acid, paddingHorizontal: 18, paddingVertical: 13, marginTop: 22 },
  buttonText: { color: colors.ink, fontFamily: 'monospace', fontSize: 10, fontWeight: '900' },
});
