import { Image, StyleSheet, View } from 'react-native';

import { useTheme } from '@/src/theme';

export function AppBackground({ uri, dimming }: { uri: string | null; dimming: number }) {
  const { colors } = useTheme();
  if (!uri) return null;

  return (
    <View accessibilityElementsHidden pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Image resizeMode="cover" source={{ uri }} style={StyleSheet.absoluteFill} />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: colors.canvas, opacity: dimming / 100 },
        ]}
      />
    </View>
  );
}
