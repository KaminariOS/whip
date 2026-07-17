import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/theme';
import type { AppTab } from '@/src/types';
import { hapticPress, type IconName } from './app-ui';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Text } from './ui/text';

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
    <View className="min-h-[66px] flex-row border-t border-border bg-background pt-1">
      {items.map(item => {
        const active = item.tab === activeTab;
        return (
          <Button
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            className="h-14 flex-1 flex-col gap-0 rounded-none px-1 py-1"
            key={item.tab}
            variant="ghost"
            onPress={hapticPress(() => onSelect(item.tab))}>
            <View className={cn('h-[30px] w-11 items-center justify-center rounded-full', active && 'bg-accent')}>
              <Ionicons name={active ? item.activeIcon : item.icon} size={20} color={active ? colors.text : colors.textSecondary} />
              {item.tab === 'terminal' && sessionCount > 0 ? (
                <Badge className="absolute -right-1 -top-1 min-w-[17px] border-2 border-background px-1 py-0">
                  <Text className="text-[9px] font-bold leading-[13px]">{sessionCount > 9 ? '9+' : sessionCount}</Text>
                </Badge>
              ) : null}
            </View>
            <Text className={cn('text-[11px] font-medium leading-[15px] text-muted-foreground', active && 'text-foreground')}>{item.label}</Text>
          </Button>
        );
      })}
    </View>
  );
}
