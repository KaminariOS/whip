import {
  isLiquidGlassSupported,
  LiquidGlassView,
} from '@callstack/liquid-glass';
import { BlurView } from 'expo-blur';
import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';

import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/theme';

interface GlassContextValue {
  blurTarget: RefObject<View | null>;
  enabled: boolean;
}

const GlassContext = createContext<GlassContextValue | null>(null);

export function GlassProvider({ blurTarget, enabled, children }: GlassContextValue & { children: ReactNode }) {
  return <GlassContext.Provider value={{ blurTarget, enabled }}>{children}</GlassContext.Provider>;
}

export function useAppGlassEnabled(): boolean {
  return useContext(GlassContext)?.enabled === true;
}

export function GlassBackdrop({
  intensity = 36,
  shapeClassName,
}: {
  intensity?: number;
  shapeClassName?: string;
}) {
  const glass = useContext(GlassContext);
  const { colors, isDark } = useTheme();
  const enabled = glass?.enabled === true;
  // Native Liquid Glass is the primary surface on supported Apple devices.
  // The app glass preference only controls the legacy blur fallback.
  const renderLiquidGlass = enabled && isLiquidGlassSupported;
  const renderNativeBlur = Platform.OS !== 'android';
  if (!enabled && !renderLiquidGlass) {
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />;
  }
  return renderLiquidGlass ? (
    <LiquidGlassView
      colorScheme={isDark ? 'dark' : 'light'}
      effect="clear"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, liquidGlassShapeStyle(shapeClassName)]}
    />
  ) : (
    <>
      {renderNativeBlur ? (
        <BlurView
          pointerEvents="none"
          blurMethod="dimezisBlurViewSdk31Plus"
          blurReductionFactor={2}
          blurTarget={glass?.blurTarget}
          intensity={intensity}
          tint={isDark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: isDark ? 'rgba(20,22,34,0.38)' : 'rgba(255,255,255,0.42)' },
        ]}
      />
    </>
  );
}

export function GlassSurface({
  children,
  className,
  intensity,
  style,
  ...props
}: React.ComponentProps<typeof View> & { intensity?: number }) {
  const glass = useContext(GlassContext);
  const { colors } = useTheme();
  return (
    <View
      className={cn('relative overflow-hidden', className)}
      style={[glass?.enabled === true ? undefined : { borderColor: colors.divider }, style]}
      {...props}>
      <GlassBackdrop intensity={intensity} shapeClassName={className} />
      {children}
    </View>
  );
}

function liquidGlassShapeStyle(className?: string): ViewStyle | undefined {
  if (!className) return undefined;
  if (className.includes('rounded-full')) return styles.roundedFull;

  const topRadius = className.match(/rounded-t-\[(\d+)px\]/)?.[1];
  if (topRadius) {
    const radius = Number(topRadius);
    return { borderTopLeftRadius: radius, borderTopRightRadius: radius };
  }

  const arbitraryRadius = className.match(/rounded-\[(\d+)px\]/)?.[1];
  if (arbitraryRadius) return { borderRadius: Number(arbitraryRadius) };
  if (className.includes('rounded-xl')) return styles.roundedXl;
  if (className.includes('rounded-lg')) return styles.roundedLg;
  if (className.includes('rounded-md')) return styles.roundedMd;
  return undefined;
}

const styles = StyleSheet.create({
  roundedFull: { borderRadius: 9999 },
  roundedLg: { borderRadius: 8 },
  roundedMd: { borderRadius: 6 },
  roundedXl: { borderRadius: 12 },
});
