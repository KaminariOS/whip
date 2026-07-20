import {
  darkColors,
  lightColors,
  resolveTheme,
  sessionTabStatusColor,
  statusColor,
} from '../src/theme';

describe('ChatGPT-style application theme', () => {
  test('resolves light and dark system themes', () => {
    expect(resolveTheme('light')).toBe(lightColors);
    expect(resolveTheme('dark')).toBe(darkColors);
    expect(resolveTheme(null)).toBe(darkColors);
  });

  test('keeps primary controls monochrome and statuses semantic', () => {
    expect(lightColors.primary).toBe('#0D0D0D');
    expect(darkColors.primary).toBe('#FFFFFF');
    expect(statusColor('blocked', lightColors)).toBe(lightColors.blocked);
    expect(statusColor('working', darkColors)).toBe(darkColors.working);
    expect(statusColor('unexpected', lightColors)).toBe(lightColors.unknown);
  });

  test('does not let a healthy terminal mask its agent status', () => {
    expect(sessionTabStatusColor('blocked', 'connected', darkColors)).toBe(darkColors.blocked);
    expect(sessionTabStatusColor('done', 'connected', darkColors)).toBe(darkColors.done);
    expect(sessionTabStatusColor('idle', 'connected', darkColors)).toBe(darkColors.idle);
    expect(sessionTabStatusColor('working', 'error', darkColors)).toBe(darkColors.blocked);
    expect(sessionTabStatusColor('working', 'disconnected', darkColors)).toBe(darkColors.idle);
  });
});
