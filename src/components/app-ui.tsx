import * as Haptics from 'expo-haptics';
import { RefreshCw, type LucideIcon } from 'lucide-react-native';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { cn } from '@/src/lib/utils';
import { agentStatusGlyph, statusMotionKind, statusTone } from '@/src/lib/statusMotion';
import { useTheme } from '@/src/theme';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Text } from './ui/text';

export function WhipMark({ size, accessibilityLabel }: { size: number; accessibilityLabel?: string }) {
  return (
    <Image
      accessibilityIgnoresInvertColors
      accessibilityLabel={accessibilityLabel}
      accessible={Boolean(accessibilityLabel)}
      source={require('../../assets/icon.png')}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}

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
  icon: LucideIcon;
  accessibilityLabel: string;
  onPress: () => void;
  className?: string;
  destructive?: boolean;
  disabled?: boolean;
  selected?: boolean;
}) {
  const { colors } = useTheme();
  const IconComponent = icon;
  return (
    <Button
      accessibilityLabel={accessibilityLabel}
      className={cn('rounded-full', selected && 'bg-primary', className)}
      disabled={disabled}
      size="icon"
      variant="ghost"
      onPress={hapticPress(onPress)}>
      <IconComponent size={21} color={destructive ? colors.error : selected ? colors.onPrimary : colors.text} />
    </Button>
  );
}

export function StatusBadge({ status, label, agentStatus = false, showIndicator = true }: { status: string; label?: string; agentStatus?: boolean; showIndicator?: boolean }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const tone = statusTone(status);
  const indicatorColor = { success: colors.working, destructive: colors.error, warning: colors.warning, muted: colors.textTertiary }[tone];
  const textClass = { success: 'text-success', destructive: 'text-destructive', warning: 'text-warning', muted: 'text-muted-foreground' }[tone];
  return (
    <Badge variant="secondary" className="gap-1.5 border-0 px-2.5 py-1">
      {showIndicator && (agentStatus
        ? <AnimatedAgentStatusGlyph status={status} color={indicatorColor} size={12} />
        : <AnimatedStatusIndicator status={status} color={indicatorColor} />)}
      <Text className={cn('text-xs font-semibold capitalize', textClass)}>{label || t(`status.${status}`, { defaultValue: status })}</Text>
    </Badge>
  );
}

export function AnimatedStatusIndicator({ status, color, size = 7 }: { status: string; color: string; size?: number }) {
  const { motion, style } = useStatusMotion(status);

  if (motion === 'spin') {
    return (
      <Animated.View style={style}>
        <RefreshCw size={Math.max(11, size)} color={color} />
      </Animated.View>
    );
  }

  return <Animated.View className="rounded-full" style={[{ width: size, height: size, backgroundColor: color }, style]} />;
}

export function AnimatedAgentStatusGlyph({ status, color, size = 18 }: { status: string; color: string; size?: number }) {
  const { motion, style, reduceMotion } = useStatusMotion(status, false);
  const frame = useSpinnerFrame(motion === 'spin' && !reduceMotion);
  return (
    <Animated.View className="items-center justify-center" style={[{ width: size, height: size + 2 }, style]}>
      <Text style={{ color, fontSize: size, lineHeight: size + 2 }}>{agentStatusGlyph(status, frame)}</Text>
    </Animated.View>
  );
}

export function AnimatedEntrance({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduceMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [delay, progress, reduceMotion]);

  return (
    <Animated.View
      className={className}
      style={{
        opacity: progress,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
      }}>
      {children}
    </Animated.View>
  );
}

function useStatusMotion(status: string, rotateSpinning = true) {
  const motion = statusMotionKind(status);
  const reduceMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);
    if (reduceMotion || motion === 'static' || (motion === 'spin' && !rotateSpinning)) return;

    const animation = motion === 'spin'
      ? Animated.loop(Animated.timing(progress, {
          toValue: 1,
          duration: 900,
          easing: Easing.linear,
          useNativeDriver: true,
        }))
      : Animated.loop(Animated.sequence([
          Animated.timing(progress, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(progress, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]));
    animation.start();
    return () => animation.stop();
  }, [motion, progress, reduceMotion, rotateSpinning]);

  const style = motion === 'spin' && rotateSpinning
    ? { transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }
    : motion === 'pulse'
      ? {
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55] }),
          transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] }) }],
        }
      : undefined;
  return { motion, style, reduceMotion };
}

function useSpinnerFrame(enabled: boolean) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    if (!enabled) return;
    const interval = setInterval(() => setFrame(value => value + 1), 80);
    return () => clearInterval(interval);
  }, [enabled]);

  return frame;
}

function useReducedMotion() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (mounted) setReduceMotion(value);
    }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
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
