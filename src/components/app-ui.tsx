import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/theme';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Text } from './ui/text';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

export function hapticPress(handler?: () => void | Promise<void>) {
  return () => {
    Haptics.selectionAsync().catch(() => undefined);
    handler?.();
  };
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  className,
  destructive = false,
  disabled = false,
  selected = false,
}: {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  className?: string;
  destructive?: boolean;
  disabled?: boolean;
  selected?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Button
      accessibilityLabel={accessibilityLabel}
      className={cn('rounded-full', selected && 'bg-primary', className)}
      disabled={disabled}
      size="icon"
      variant="ghost"
      onPress={hapticPress(onPress)}>
      <Ionicons name={icon} size={21} color={destructive ? colors.error : selected ? colors.onPrimary : colors.text} />
    </Button>
  );
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = status === 'running' || status === 'done' || status === 'connected' || status === 'active'
    ? 'success' as const
    : status === 'error' || status === 'failed' || status === 'disconnected'
      ? 'destructive' as const
      : status === 'waiting' || status === 'connecting'
        ? 'warning' as const
        : 'muted' as const;
  const dotClass = { success: 'bg-success', destructive: 'bg-destructive', warning: 'bg-warning', muted: 'bg-muted-foreground' }[tone];
  const textClass = { success: 'text-success', destructive: 'text-destructive', warning: 'text-warning', muted: 'text-muted-foreground' }[tone];
  return (
    <Badge variant="secondary" className="gap-1.5 border-0 px-2.5 py-1">
      <View className={cn('size-1.5 rounded-full', dotClass)} />
      <Text className={cn('text-xs font-semibold capitalize', textClass)}>{label || status}</Text>
    </Badge>
  );
}

export function ScreenHeader({ title, subtitle, left, right }: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode }) {
  return (
    <View className="min-h-16 flex-row items-center border-b border-border bg-background px-4 py-2">
      {left ? <View className="mr-2 min-w-10">{left}</View> : null}
      <View className="min-w-0 flex-1">
        <Text className="text-[17px] font-semibold leading-6" numberOfLines={1}>{title}</Text>
        {subtitle ? <Text className="text-xs leading-4 text-muted-foreground" numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right ? <View className="ml-2 min-w-10 items-end">{right}</View> : null}
    </View>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <Text className={cn('px-1 text-sm font-semibold text-muted-foreground', className)}>{children}</Text>;
}
