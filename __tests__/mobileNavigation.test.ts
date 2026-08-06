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
  expect(bottomNavigation).toContain('absolute inset-x-0 bottom-0 z-30 flex-row items-center justify-around bg-transparent');
  expect(app).toContain('<BlurTargetView ref={navigationBlurTargetRef}');
  expect(app).toContain('blurTarget={navigationBlurTargetRef}');
  expect(bottomNavigation).toContain("import { BlurView } from 'expo-blur';");
  expect(bottomNavigation).toContain('blurMethod="dimezisBlurViewSdk31Plus"');
  expect(bottomNavigation).toContain('style={[styles.glassSurface, floatingGlassEdgeStyle(active, colors)]}');
  expect(bottomNavigation).toContain("active ? 'C4' : 'B8'");
  expect(bottomNavigation).toContain('style={floatingBloomStyle(active, colors)}');
  expect(bottomNavigation).toContain('filter: [{ blur:');
  expect(bottomNavigation).not.toContain('glassHighlight');
  expect(bottomNavigation).toContain('<HerdrMark size={23} />');
  expect(bottomNavigation).toContain('<Icon as={item.icon} size={23}');
  expect(bottomNavigation).not.toContain('border-t');
  expect(bottomNavigation).not.toContain('flex-1 rounded-none');
  expect(bottomNavigation).not.toContain('<Text');
});
