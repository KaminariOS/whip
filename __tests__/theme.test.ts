import { darkColors, lightColors, resolveTheme, statusColor } from '../src/theme';

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
});
