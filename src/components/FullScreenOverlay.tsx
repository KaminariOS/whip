import type { PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

export function FullScreenOverlay({ children }: PropsWithChildren) {
  return (
    <View className="bg-background" style={styles.root}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 60,
  },
});
