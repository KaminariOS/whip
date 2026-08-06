import { BlurView } from 'expo-blur';
import { CircleEllipsis, Server, SquareTerminal, type LucideIcon } from 'lucide-react-native';
import { type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme, type ThemeColors } from '@/src/theme';
import type { AppTab } from '@/src/types';
import { hapticPress, HerdrMark } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';

interface Props {
  activeTab: AppTab;
  blurTarget: RefObject<View | null>;
  onSelect: (tab: AppTab) => void;
}

type NavigationItem = {
  tab: AppTab;
  labelKey: string;
} & ({ icon: LucideIcon } | { herdrMark: true });

const items: NavigationItem[] = [
  { tab: 'hosts', labelKey: 'nav.hosts', icon: Server },
  { tab: 'herd', labelKey: 'nav.herd', herdrMark: true },
  { tab: 'terminal', labelKey: 'nav.terminal', icon: SquareTerminal },
  { tab: 'more', labelKey: 'nav.more', icon: CircleEllipsis },
];

export function BottomNavigation({ activeTab, blurTarget, onSelect }: Props) {
  const { colors, isDark } = useTheme();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0 z-30 flex-row items-center justify-around bg-transparent px-6"
      style={{ height: 56 + bottom, paddingBottom: bottom }}>
      {items.map(item => {
        const active = item.tab === activeTab;
        return (
          <View className="h-[60px] w-[60px] items-center justify-center" key={item.tab}>
            <View
              pointerEvents="none"
              className="absolute h-[52px] w-[52px] rounded-full"
              style={floatingBloomStyle(active, colors)}
            />
            <BlurView
              pointerEvents="none"
              blurMethod="dimezisBlurViewSdk31Plus"
              blurReductionFactor={2}
              blurTarget={blurTarget}
              intensity={active ? 34 : 26}
              tint={isDark ? 'systemUltraThinMaterialDark' : 'default'}
              style={[styles.glassSurface, floatingGlassEdgeStyle(active, colors)]}
            />
            <Button
              accessibilityLabel={t(item.labelKey)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              className="h-12 w-12 rounded-full bg-transparent p-0 active:bg-white/10 dark:bg-transparent dark:active:bg-white/10"
              variant="ghost"
              onPress={hapticPress(() => onSelect(item.tab))}>
              <View className={active ? 'items-center justify-center opacity-100' : 'items-center justify-center opacity-60'}>
                {'herdrMark' in item
                  ? <HerdrMark size={23} />
                  : <Icon as={item.icon} size={23} color={active ? colors.text : colors.textSecondary} strokeWidth={active ? 2.75 : 2} />}
              </View>
            </Button>
          </View>
        );
      })}
    </View>
  );
}

function floatingGlassEdgeStyle(active: boolean, colors: ThemeColors) {
  const edgeColor = active ? colors.primary : colors.textSecondary;
  return {
    borderColor: colorWithAlpha(edgeColor, active ? 'E0' : '8F'),
  };
}

function floatingBloomStyle(active: boolean, colors: ThemeColors) {
  const edgeColor = active ? colors.primary : colors.textSecondary;
  return {
    backgroundColor: 'transparent',
    borderColor: colorWithAlpha(edgeColor, active ? 'B8' : '73'),
    borderWidth: active ? 2 : 1,
    filter: [{ blur: active ? 6 : 4 }],
  } as const;
}

function colorWithAlpha(color: string, alpha: string) {
  return /^#[\da-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}

const styles = StyleSheet.create({
  glassSurface: {
    position: 'absolute',
    width: 48,
    height: 48,
    overflow: 'hidden',
    borderRadius: 24,
    borderWidth: 1,
  },
});
