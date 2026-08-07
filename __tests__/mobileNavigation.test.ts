import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  handleMobileBack,
  initialMobileNavigation,
  selectMobileTab,
} from '../src/mobileNavigation';

test('terminal exit returns to the last non-terminal destination', () => {
  const herd = selectMobileTab(initialMobileNavigation, 'herd');
  const terminal = selectMobileTab(herd, 'terminal');
  expect(handleMobileBack(terminal)).toEqual({ handled: true, state: herd });
});

test('back returns non-host roots to hosts and leaves host root to Android', () => {
  const herd = selectMobileTab(initialMobileNavigation, 'herd');
  expect(handleMobileBack(herd).state.tab).toBe('hosts');
  expect(handleMobileBack(initialMobileNavigation).handled).toBe(false);
});

test('bottom navigation shows icons without visible labels', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const bottomNavigation = readFileSync(
    resolve(__dirname, '../src/components/BottomNavigation.tsx'),
    'utf8',
  );

  expect(bottomNavigation).toContain('accessibilityLabel={t(item.labelKey)}');
  expect(bottomNavigation).toContain('pointerEvents="box-none"');
  expect(bottomNavigation).toContain('absolute inset-x-0 z-30 flex-row items-center justify-around bg-transparent');
  expect(app).toContain("const NavigationBlurTarget = Platform.OS === 'android' ? View : BlurTargetView;");
  expect(app).toContain('<NavigationBlurTarget ref={navigationBlurTargetRef}');
  expect(app).toContain('blurTarget={navigationBlurTargetRef}');
  expect(app).toContain("style={navigation.tab === 'hosts' ? styles.tabScreen : styles.hiddenTab}");
  expect(app).toContain("style={navigation.tab === 'herd' ? styles.tabScreen : styles.hiddenTab}");
  expect(app).toContain("style={navigation.tab === 'more' ? styles.tabScreen : styles.hiddenTab}");
  expect(app).toContain("importantForAccessibility={navigation.tab === 'herd' ? 'auto' : 'no-hide-descendants'}");
  expect(app).toContain("style={immersiveTerminal ? styles.hiddenTab : styles.tabScreen}");
  expect(bottomNavigation).toContain("import { BlurView } from 'expo-blur';");
  expect(bottomNavigation).toContain("const renderNativeBlur = Platform.OS !== 'android';");
  expect(bottomNavigation).toContain('renderNativeBlur ? (');
  expect(bottomNavigation).toContain('blurMethod="dimezisBlurViewSdk31Plus"');
  expect(bottomNavigation).toContain('intensity={active ? 34 : 26}');
  expect(bottomNavigation).toContain("tint={isDark ? 'systemUltraThinMaterialDark' : 'default'}");
  expect(bottomNavigation).toContain('style={[styles.glassSurface, floatingGlassEdgeStyle(active, colors)]}');
  expect(bottomNavigation).toContain('opacity: 0.62');
  expect(bottomNavigation).toContain('floatingGlassFallbackStyle(isDark)');
  expect(bottomNavigation).toContain("backgroundColor: isDark ? 'rgba(20,22,34,0.38)' : 'rgba(255,255,255,0.42)'");
  expect(bottomNavigation).not.toContain('floatingGlassTintStyle');
  expect(bottomNavigation).toContain('style={floatingBloomStyle(active, colors)}');
  expect(bottomNavigation).toContain("backgroundColor: 'transparent'");
  expect(bottomNavigation).toContain('filter: [{ blur:');
  expect(bottomNavigation).not.toContain('glassHighlight');
  expect(bottomNavigation).toContain('<HerdrMark size={29} />');
  expect(bottomNavigation).toContain('<Icon as={item.icon} size={29}');
  expect(bottomNavigation).toContain('className="h-16 w-16 rounded-full');
  expect(bottomNavigation).toContain('style={{ bottom: 16, height: 120 + bottom, paddingBottom: bottom }}');
  expect(bottomNavigation).not.toContain('border-t');
  expect(bottomNavigation).not.toContain('flex-1 rounded-none');
  expect(bottomNavigation).not.toContain('<Text');
});
