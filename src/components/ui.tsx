import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps, ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View, type PressableProps, type TextInputProps, type ViewStyle } from 'react-native';

import { radii, spacing, statusColor, useTheme } from '../theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export function Button({
  label,
  icon,
  variant = 'primary',
  compact = false,
  haptic = true,
  style,
  ...props
}: PressableProps & {
  label: string;
  icon?: IconName;
  variant?: ButtonVariant;
  compact?: boolean;
  haptic?: boolean;
  style?: ViewStyle | ViewStyle[];
}) {
  const { colors } = useTheme();
  const foreground = variant === 'primary'
    ? colors.onPrimary
    : variant === 'destructive'
      ? colors.error
      : colors.text;
  const background = variant === 'primary'
    ? colors.primary
    : variant === 'secondary'
      ? colors.surface
      : 'transparent';

  return (
    <Pressable
      accessibilityRole="button"
      {...props}
      onPress={event => {
        if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        props.onPress?.(event);
      }}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: background, borderColor: variant === 'secondary' ? colors.divider : 'transparent' },
        pressed && styles.pressed,
        props.disabled && styles.disabled,
        style,
      ]}>
      {icon && <Ionicons name={icon} size={compact ? 16 : 18} color={foreground} />}
      <Text style={[styles.buttonText, { color: foreground }]}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({ icon, label, selected = false, size = 40, ...props }: PressableProps & {
  icon: IconName;
  label: string;
  selected?: boolean;
  size?: number;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...props}
      style={({ pressed }) => [
        styles.iconButton,
        { width: size, height: size, borderRadius: size / 2 },
        (pressed || selected) && { backgroundColor: colors.surfaceRaised },
        props.disabled && styles.disabled,
      ]}>
      <Ionicons name={icon} size={Math.round(size * 0.48)} color={colors.text} />
    </Pressable>
  );
}

export function Input(props: TextInputProps) {
  const { colors } = useTheme();
  return (
    <TextInput
      placeholderTextColor={colors.textSecondary}
      {...props}
      style={[styles.input, { color: colors.text, backgroundColor: colors.input, borderColor: colors.divider }, props.style]}
    />
  );
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const { colors } = useTheme();
  const tint = statusColor(status, colors);
  return (
    <View style={[styles.badge, { backgroundColor: `${tint}1F` }]}>
      <View style={[styles.badgeDot, { backgroundColor: tint }]} />
      <Text style={[styles.badgeText, { color: tint }]}>{label || status}</Text>
    </View>
  );
}

export function ScreenHeader({ title, subtitle, left, right }: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.header, { backgroundColor: colors.canvas, borderBottomColor: colors.divider }]}>
      {left && <View style={styles.headerSide}>{left}</View>}
      <View style={styles.headerCopy}>
        <Text numberOfLines={1} style={[styles.headerTitle, { color: colors.text }]}>{title}</Text>
        {subtitle && <Text numberOfLines={1} style={[styles.headerSubtitle, { color: colors.textSecondary }]}>{subtitle}</Text>}
      </View>
      {right && <View style={[styles.headerSide, styles.headerRight]}>{right}</View>}
    </View>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonCompact: { minHeight: 36, paddingHorizontal: spacing.md },
  buttonText: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
  pressed: { opacity: Platform.OS === 'android' ? 0.72 : 0.8, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.45 },
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  input: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 16,
    lineHeight: 22,
  },
  badge: { minHeight: 26, borderRadius: radii.full, paddingHorizontal: 9, flexDirection: 'row', gap: 6, alignItems: 'center' },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12, lineHeight: 16, fontWeight: '600', textTransform: 'capitalize' },
  header: {
    minHeight: 64,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerSide: { minWidth: 44, alignItems: 'flex-start', justifyContent: 'center' },
  headerRight: { alignItems: 'flex-end' },
  headerCopy: { flex: 1, minWidth: 0, paddingHorizontal: 8 },
  headerTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  headerSubtitle: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  sectionLabel: { fontSize: 12, lineHeight: 16, fontWeight: '600', marginBottom: 8 },
});
