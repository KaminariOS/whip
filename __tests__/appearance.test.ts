import { resolveColorScheme } from '../src/lib/appearance';

describe('appearance preference', () => {
  test.each([
    ['system', 'unspecified'],
    ['light', 'light'],
    ['dark', 'dark'],
  ] as const)('maps %s to the React Native color scheme %s', (preference, expected) => {
    expect(resolveColorScheme(preference)).toBe(expected);
  });
});
