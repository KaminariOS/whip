import {
  insetContentPadding,
  sessionTopChromeInset,
  terminalBottomChromeInset,
  terminalControlBarInset,
  visualContentInsets,
} from '../src/lib/floatingChrome';

describe('floating chrome geometry', () => {
  test('uses one tab-bar height and adds the pane bar only for multiple panes', () => {
    expect(sessionTopChromeInset(0)).toBe(55);
    expect(sessionTopChromeInset(1)).toBe(55);
    expect(sessionTopChromeInset(2)).toBe(99);
  });

  test('includes safe area, keyboard, and a dynamically measured composer', () => {
    const controlBarHeight = terminalControlBarInset(34);
    expect(controlBarHeight).toBe(84);
    expect(
      terminalBottomChromeInset({
        composerHeight: 112,
        composerVisible: true,
        controlBarHeight,
        keyboardInset: 301,
      }),
    ).toBe(497);
    expect(
      terminalBottomChromeInset({
        composerHeight: 112,
        composerVisible: false,
        controlBarHeight,
        keyboardInset: 0,
      }),
    ).toBe(84);
  });

  test('content padding places first and last items outside occluded regions', () => {
    const insets = visualContentInsets(92, 186);
    expect(insetContentPadding(insets, { top: 16, bottom: 24 })).toEqual({
      top: 108,
      bottom: 210,
    });
  });
});
