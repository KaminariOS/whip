import {
  isLiquidGlassSupported,
  LiquidGlassView,
} from '@callstack/liquid-glass';
import { BlurView } from 'expo-blur';
import { createContext, useContext, useEffect, type ReactNode, type RefObject } from 'react';
import { cssInterop } from 'nativewind';
import { Platform, StyleSheet, View } from 'react-native';

import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/theme';

interface GlassContextValue {
  blurTarget: RefObject<View | null>;
  enabled: boolean;
}

const GlassContext = createContext<GlassContextValue | null>(null);

cssInterop(LiquidGlassView, { className: 'style' });

export function GlassProvider({ blurTarget, enabled, children }: GlassContextValue & { children: ReactNode }) {
  useEffect(() => {
    console.info('[LiquidGlass] capability', {
      isLiquidGlassSupported,
      legacyGlassEnabled: enabled,
      platform: Platform.OS,
    });
  }, [enabled]);

  return <GlassContext.Provider value={{ blurTarget, enabled }}>{children}</GlassContext.Provider>;
}

export function useAppGlassEnabled(): boolean {
  return useContext(GlassContext)?.enabled === true;
}

export function GlassBackdrop({ intensity = 36 }: { intensity?: number }) {
  const glass = useContext(GlassContext);
  const { colors, isDark } = useTheme();
  const enabled = glass?.enabled === true;
  // Native Liquid Glass is the primary surface on supported Apple devices.
  // The app glass preference only controls the legacy blur fallback.
  const renderLiquidGlass = isLiquidGlassSupported;
  const renderNativeBlur = Platform.OS !== 'android';
  if (!enabled && !renderLiquidGlass) {
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />;
  }
  return renderLiquidGlass ? (
    <LiquidGlassView
      colorScheme={isDark ? 'dark' : 'light'}
      effect="regular"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
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
  const { colors, isDark } = useTheme();
  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        className={cn('relative overflow-hidden', className)}
        colorScheme={isDark ? 'dark' : 'light'}
        effect="regular"
        style={style}
        {...props}>
        {children}
      </LiquidGlassView>
    );
  }
  return (
    <View
      className={cn('relative overflow-hidden', className)}
      style={[glass?.enabled === true ? undefined : { borderColor: colors.divider }, style]}
      {...props}>
      <GlassBackdrop intensity={intensity} />
      {children}
    </View>
  );
}
