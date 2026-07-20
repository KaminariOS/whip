import { ChevronRight, Info, Settings } from 'lucide-react-native';
import { View } from 'react-native';

import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  connectedHost: string | null;
  onOpenAbout: () => void;
  onOpenSettings: () => void;
}

export function MoreScreen({ connectedHost, onOpenAbout, onOpenSettings }: Props) {
  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border px-5 py-5">
        <Text className="text-[22px] font-semibold leading-7">More</Text>
        <Text className="mt-1 text-sm text-muted-foreground">{connectedHost ? `Connected to ${connectedHost}` : 'No active connection'}</Text>
      </View>
      <View className="px-4 py-5">
        <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">Preferences</Text>
        <Button className="h-auto w-full justify-start rounded-lg border border-border bg-card px-4 py-4" variant="outline" onPress={hapticPress(onOpenSettings)}>
          <View className="size-11 items-center justify-center rounded-full bg-accent">
            <Icon as={Settings} size={22} />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-semibold">Settings</Text>
            <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">Notifications, speech, terminal and connection preferences</Text>
          </View>
          <Icon as={ChevronRight} className="text-muted-foreground" size={20} />
        </Button>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">App</Text>
        <Button className="h-auto w-full justify-start rounded-lg border border-border bg-card px-4 py-4" variant="outline" onPress={hapticPress(onOpenAbout)}>
          <View className="size-11 items-center justify-center rounded-full bg-accent">
            <Icon as={Info} size={22} />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-semibold">About Whip</Text>
            <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">Herdr compatibility and project source</Text>
          </View>
          <Icon as={ChevronRight} className="text-muted-foreground" size={20} />
        </Button>
      </View>
    </View>
  );
}
