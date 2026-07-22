import {
  darkColors,
  githubLightPalette,
  lightColors,
  resolveTheme,
  sessionTabStatusColor,
  statusColor,
  terminalColors,
  tokyoNightPalette,
} from '../src/theme';

describe('application theme', () => {
  test('resolves light and dark system themes', () => {
    expect(resolveTheme('light')).toBe(lightColors);
    expect(resolveTheme('dark')).toBe(darkColors);
    expect(resolveTheme(null)).toBe(darkColors);
  });

  test('uses GitHub Light for light controls and semantic statuses', () => {
    expect(lightColors.canvas).toBe('#FFFFFF');
    expect(lightColors.surface).toBe('#F6F8FA');
    expect(lightColors.text).toBe('#24292F');
    expect(lightColors.primary).toBe('#0969DA');
    expect(lightColors.working).toBe(githubLightPalette.green);
    expect(lightColors.blocked).toBe(githubLightPalette.red);
  });

  test('uses Tokyo Night for dark controls and the terminal', () => {
    expect(darkColors.canvas).toBe('#1A1B26');
    expect(darkColors.primary).toBe('#7AA2F7');
    expect(darkColors.text).toBe('#C0CAF5');
    expect(terminalColors.canvas).toBe(tokyoNightPalette.background);
    expect(terminalColors.accent).toBe(tokyoNightPalette.blue);
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
