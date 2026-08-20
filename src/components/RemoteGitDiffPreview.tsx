import { FileWarning, GitCompareArrows } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  FlatList,
  type LayoutChangeEvent,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import type { RemoteGitDiffRow, RemoteGitDiff } from '@/src/lib/remoteGit';
import { terminalFontFamily } from '@/src/lib/terminalFonts';
import { useTheme, type ThemeColors } from '@/src/theme';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  diff: RemoteGitDiff;
  filename: string;
  onOpenFile: (() => void) | null;
}

const LINE_HEIGHT = 20;
const GUTTER_WIDTH = 38;
const MARKER_WIDTH = 20;
const APPROXIMATE_GLYPH_WIDTH = 7.2;
const MAX_MEASURED_COLUMNS = 240;

export function RemoteGitDiffPreview({ diff, filename, onOpenFile }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const contentWidth = useMemo(() => {
    const columns = diff.rows.reduce(
      (longest, row) =>
        Math.max(longest, Math.min(MAX_MEASURED_COLUMNS, row.content.length)),
      1,
    );
    return Math.max(
      viewport.width,
      GUTTER_WIDTH * 2 + MARKER_WIDTH + columns * APPROXIMATE_GLYPH_WIDTH + 24,
    );
  }, [diff.rows, viewport.width]);

  if (diff.kind !== 'text') {
    return (
      <View className="flex-1 items-center justify-center bg-background p-8">
        {diff.kind === 'binary' ? (
          <FileWarning size={32} color={colors.warning} />
        ) : (
          <GitCompareArrows size={32} color={colors.textSecondary} />
        )}
        <Text className="mt-4 text-center text-[15px] font-semibold text-foreground">
          {t(
            diff.kind === 'binary'
              ? 'files.gitDiffBinary'
              : 'files.gitDiffEmpty',
          )}
        </Text>
        <Text className="mt-2 max-w-[320px] text-center text-[12px] leading-[18px] text-muted-foreground">
          {t(
            diff.kind === 'binary'
              ? 'files.gitDiffBinaryCopy'
              : 'files.gitDiffEmptyCopy',
          )}
        </Text>
        {onOpenFile ? (
          <Button
            className="mt-5 rounded-full"
            variant="secondary"
            onPress={hapticPress(onOpenFile)}
          >
            <Text>{t('files.gitOpenNormally')}</Text>
          </Button>
        ) : null}
      </View>
    );
  }

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport({ width, height });
  };

  return (
    <View className="flex-1 bg-background" onLayout={handleLayout}>
      {viewport.width > 0 && viewport.height > 0 ? (
        <ScrollView
          horizontal
          bounces={false}
          contentContainerStyle={{ minWidth: viewport.width }}
          showsHorizontalScrollIndicator
        >
          <FlatList
            data={diff.rows}
            initialNumToRender={60}
            keyExtractor={row => row.key}
            ListHeaderComponent={
              diff.truncated ? (
                <View
                  style={[
                    styles.notice,
                    { backgroundColor: colorWithAlpha(colors.warning, '1F') },
                  ]}
                >
                  <Text style={[styles.noticeText, { color: colors.warning }]}>
                    {t('files.gitDiffTruncated')}
                  </Text>
                </View>
              ) : null
            }
            maxToRenderPerBatch={80}
            removeClippedSubviews={Platform.OS === 'android'}
            renderItem={({ item }) => <DiffRow colors={colors} row={item} />}
            style={{ height: viewport.height, width: contentWidth }}
            updateCellsBatchingPeriod={30}
            windowSize={12}
          />
        </ScrollView>
      ) : null}
      <View className="absolute bottom-2 right-2 rounded-full bg-card/95 px-2.5 py-1">
        <Text className="font-mono text-[8px] text-muted-foreground">
          {filename}
        </Text>
      </View>
    </View>
  );
}

function DiffRow({
  colors,
  row,
}: {
  colors: ThemeColors;
  row: RemoteGitDiffRow;
}) {
  const backgroundColor =
    row.kind === 'addition'
      ? colorWithAlpha(colors.working, '1C')
      : row.kind === 'deletion'
      ? colorWithAlpha(colors.error, '1C')
      : row.kind === 'hunk'
      ? colorWithAlpha(colors.primary, '18')
      : row.kind === 'header'
      ? colors.surface
      : colors.canvas;
  const foreground =
    row.kind === 'addition'
      ? colors.working
      : row.kind === 'deletion'
      ? colors.error
      : row.kind === 'hunk'
      ? colors.primary
      : row.kind === 'header' || row.kind === 'meta'
      ? colors.textSecondary
      : colors.text;
  return (
    <View style={[styles.row, { backgroundColor }]}>
      <Text style={[styles.gutter, { color: colors.textTertiary }]}>
        {row.oldLine ?? ''}
      </Text>
      <Text style={[styles.gutter, { color: colors.textTertiary }]}>
        {row.newLine ?? ''}
      </Text>
      <Text style={[styles.marker, { color: foreground }]}>{row.marker}</Text>
      <Text
        numberOfLines={1}
        selectable
        style={[styles.content, { color: foreground }]}
      >
        {row.content || ' '}
      </Text>
    </View>
  );
}

function colorWithAlpha(color: string, alpha: string): string {
  return /^#[\da-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    fontFamily: terminalFontFamily,
    fontSize: 11,
    lineHeight: LINE_HEIGHT,
    paddingRight: 12,
  },
  gutter: {
    fontFamily: terminalFontFamily,
    fontSize: 9,
    lineHeight: LINE_HEIGHT,
    textAlign: 'right',
    width: GUTTER_WIDTH,
  },
  marker: {
    fontFamily: terminalFontFamily,
    fontSize: 11,
    lineHeight: LINE_HEIGHT,
    textAlign: 'center',
    width: MARKER_WIDTH,
  },
  notice: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  noticeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    minHeight: LINE_HEIGHT,
  },
});
