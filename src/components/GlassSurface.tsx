import { BlurView } from 'expo-blur';
import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

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

export function GlassBackdrop({ intensity = 36 }: { intensity?: number }) {
  const glass = useContext(GlassContext);
  const { colors, isDark } = useTheme();
  const enabled = glass?.enabled === true;
  const renderNativeBlur = Platform.OS !== 'android';
  if (!enabled) {
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />;
  }
  return (
    <>
      {renderNativeBlur ? (
        <BlurView
          pointerEvents="none"
          blurMethod="dimezisBlurViewSdk31Plus"
          blurReductionFactor={2}
          blurTarget={glass.blurTarget}
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
      <GlassBackdrop intensity={intensity} />
      {children}
    </View>
  );
}
