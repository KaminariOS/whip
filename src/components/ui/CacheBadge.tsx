import { Platform, View } from 'react-native';

import { Text } from './text';

export function CacheBadge({ label, color }: { label: string; color: string }) {
  return (
    <View
      className="shrink-0 flex-row items-center rounded-full px-2 py-0.5"
      style={{ backgroundColor: `${color}1F` }}
    >
      <Text
        style={{ color, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11 }}
      >
        {label}
      </Text>
    </View>
  );
}
