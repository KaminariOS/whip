import { useColorScheme } from 'react-native';

export const lightColors = {
  canvas: '#FFFFFF',
  sidebar: '#F9F9F9',
  surface: '#F7F7F8',
  surfaceRaised: '#ECECEC',
  divider: '#E5E5E5',
  text: '#0D0D0D',
  textSecondary: '#676767',
  textTertiary: '#8E8E8E',
  primary: '#0D0D0D',
  onPrimary: '#FFFFFF',
  disabled: '#CCCCCC',
  input: '#FFFFFF',
  scrim: '#00000066',
  link: '#2A7FFF',
  working: '#0F9F7A',
  blocked: '#D83A3A',
  done: '#0F9F7A',
  idle: '#8E8E8E',
  unknown: '#D97706',
  warning: '#D97706',
  error: '#D83A3A',
} as const;

export const darkColors = {
  canvas: '#212121',
  sidebar: '#181818',
  surface: '#2F2F2F',
  surfaceRaised: '#424242',
  divider: '#424242',
  text: '#ECECEC',
  textSecondary: '#B4B4B4',
  textTertiary: '#8E8E8E',
  primary: '#FFFFFF',
  onPrimary: '#0D0D0D',
  disabled: '#4D4D4D',
  input: '#2F2F2F',
  scrim: '#00000099',
  link: '#6EA8FF',
  working: '#42C59A',
  blocked: '#FF6B6B',
  done: '#42C59A',
  idle: '#8E8E8E',
  unknown: '#F2A94A',
  warning: '#F2A94A',
  error: '#FF6B6B',
} as const;

export type ThemeColors = { [Key in keyof typeof lightColors]: string };

export const terminalColors = {
  canvas: '#212121',
  panel: '#181818',
  panelRaised: '#2F2F2F',
  line: '#424242',
  text: '#ECECEC',
  muted: '#B4B4B4',
  accent: '#FFFFFF',
  working: darkColors.working,
  blocked: darkColors.blocked,
  done: darkColors.done,
  idle: darkColors.idle,
  unknown: darkColors.unknown,
};

// Compatibility for terminal-only components. Management UI should use useTheme().
export const colors = {
  ink: terminalColors.canvas,
  panel: terminalColors.panel,
  panelRaised: terminalColors.panelRaised,
  line: terminalColors.line,
  text: terminalColors.text,
  muted: terminalColors.muted,
  acid: terminalColors.accent,
  working: terminalColors.working,
  blocked: terminalColors.blocked,
  done: terminalColors.done,
  idle: terminalColors.idle,
  unknown: terminalColors.unknown,
};

export function resolveTheme(scheme: 'light' | 'dark' | 'unspecified' | null | undefined): ThemeColors {
  return scheme === 'light' ? lightColors : darkColors;
}

export function useTheme() {
  const scheme = useColorScheme();
  const isDark = scheme !== 'light';
  return { colors: resolveTheme(scheme), isDark, scheme: isDark ? 'dark' as const : 'light' as const };
}

export function statusColor(status: string, palette: ThemeColors | typeof colors = colors): string {
  const key = status as 'working' | 'blocked' | 'done' | 'idle' | 'unknown';
  return palette[key] || palette.unknown;
}

export const radii = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  full: 999,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};
