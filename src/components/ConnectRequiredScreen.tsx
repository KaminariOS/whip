import { Server } from 'lucide-react-native';
import { View } from 'react-native';

import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export function ConnectRequiredScreen({ destination, onPickHost }: { destination: string; onPickHost: () => void }) {
  return (
    <View className="flex-1 items-center justify-center bg-background px-8">
      <View className="size-16 items-center justify-center rounded-full bg-muted">
        <Icon as={Server} className="text-muted-foreground" size={27} />
      </View>
      <Text className="mt-5 text-center text-xl font-semibold">Connect to continue</Text>
      <Text className="mt-2 max-w-[320px] text-center text-[15px] leading-[22px] text-muted-foreground">
        Choose a saved host before opening {destination.toLowerCase()}.
      </Text>
      <Button className="mt-6 rounded-full px-5" onPress={hapticPress(onPickHost)}>
        <Text>Choose a host</Text>
      </Button>
    </View>
  );
}
