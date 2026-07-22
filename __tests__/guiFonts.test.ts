import { guiFontFamilies, guiFontFamilyForClasses } from '../src/lib/guiFonts';

describe('GUI font family', () => {
  it.each([
    ['text-base', guiFontFamilies.regular],
    ['font-medium', guiFontFamilies.medium],
    ['font-semibold', guiFontFamilies.semiBold],
    ['font-bold', guiFontFamilies.bold],
    ['font-extrabold', guiFontFamilies.extraBold],
    ['font-black', guiFontFamilies.black],
  ])('maps %s to its Inter face', (className, expected) => {
    expect(guiFontFamilyForClasses(className)).toBe(expected);
  });

  it('leaves deliberate monospace text unchanged', () => {
    expect(guiFontFamilyForClasses('font-mono font-black')).toBeUndefined();
  });
});
