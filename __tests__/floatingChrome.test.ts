import {
  insetContentPadding,
  terminalBottomChromeClearance,
  terminalBottomChromeInset,
  terminalControlBarInset,
  terminalLatestButtonBottom,
  terminalSessionChromeHeight,
  visualContentInsets,
} from '../src/lib/floatingChrome';

describe('floating chrome geometry', () => {
  test('places the latest button above the visible session rail', () => {
    const terminalBottomInset = terminalControlBarInset(34);
    const singlePaneChromeInset = terminalSessionChromeHeight(1);
    const multiPaneChromeInset = terminalSessionChromeHeight(2);

    expect(singlePaneChromeInset).toBe(55);
    expect(multiPaneChromeInset).toBe(99);
    expect(
      terminalBottomChromeClearance({
        sessionChromeInset: singlePaneChromeInset,
        sessionChromeVisible: true,
        terminalBottomInset,
      }),
    ).toBe(139);
    expect(
      terminalBottomChromeClearance({
        sessionChromeInset: multiPaneChromeInset,
        sessionChromeVisible: true,
        terminalBottomInset,
      }),
    ).toBe(183);
    expect(
      terminalBottomChromeClearance({
        sessionChromeInset: multiPaneChromeInset,
        sessionChromeVisible: false,
        terminalBottomInset,
      }),
    ).toBe(84);
    expect(
      terminalLatestButtonBottom({
        sessionChromeInset: singlePaneChromeInset,
        sessionChromeVisible: true,
        terminalBottomInset,
      }),
    ).toBe(151);
    expect(
      terminalLatestButtonBottom({
        sessionChromeInset: multiPaneChromeInset,
        sessionChromeVisible: true,
        terminalBottomInset,
      }),
    ).toBe(195);
    expect(
      terminalLatestButtonBottom({
        sessionChromeInset: multiPaneChromeInset,
        sessionChromeVisible: false,
        terminalBottomInset,
      }),
    ).toBe(96);
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
    const insets = visualContentInsets(0, 186);
    expect(insetContentPadding(insets, { top: 16, bottom: 24 })).toEqual({
      top: 16,
      bottom: 210,
    });
  });
});
