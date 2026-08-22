import type { ViewStyle } from 'react-native';

// Keep these in sync with the radius tokens in tailwind.config.js and
// global.css. The native glass view does not receive the wrapper's className,
// so it needs the resolved radius explicitly to avoid drawing a second curve.
const GLASS_RADIUS = {
  full: 9999,
  lg: 16,
  md: 12,
  xl: 12,
} as const;

export function liquidGlassShapeStyle(className?: string): ViewStyle | undefined {
  if (!className) return undefined;
  if (className.includes('rounded-full')) return { borderRadius: GLASS_RADIUS.full };

  const topRadius = className.match(/rounded-t-\[(\d+)px\]/)?.[1];
  if (topRadius) {
    const radius = Number(topRadius);
    return { borderTopLeftRadius: radius, borderTopRightRadius: radius };
  }

  const arbitraryRadius = className.match(/rounded-\[(\d+)px\]/)?.[1];
  if (arbitraryRadius) return { borderRadius: Number(arbitraryRadius) };
  if (className.includes('rounded-xl')) return { borderRadius: GLASS_RADIUS.xl };
  if (className.includes('rounded-lg')) return { borderRadius: GLASS_RADIUS.lg };
  if (className.includes('rounded-md')) return { borderRadius: GLASS_RADIUS.md };
  return undefined;
}
