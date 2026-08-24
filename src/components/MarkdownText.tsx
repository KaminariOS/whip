import { useMemo } from 'react';
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';
import type { TextStyle, ViewStyle } from 'react-native';

import { guiFontFamilies } from '../lib/guiFonts';
import { normalizeRichTextMarkdown } from '../lib/richTextMarkdown';
import { useTheme } from '../theme';

interface Props {
  content: string;
  containerStyle?: ViewStyle | TextStyle;
  onLinkPress?: (link: { url: string }) => void;
  selectable?: boolean;
  variant?: 'default' | 'transcript';
}

export function useWhipMarkdownStyle(variant: Props['variant'] = 'default'): MarkdownStyle {
  const { colors } = useTheme();
  return useMemo<MarkdownStyle>(
    () => ({
      paragraph: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        fontSize: 14,
        lineHeight: 22,
        marginBottom: 10,
      },
      h1: {
        color: colors.text,
        fontFamily: guiFontFamilies.bold,
        fontWeight: 'normal',
        fontSize: 24,
        lineHeight: 30,
        marginBottom: 12,
        marginTop: 4,
      },
      h2: {
        color: colors.text,
        fontFamily: guiFontFamilies.bold,
        fontWeight: 'normal',
        fontSize: 20,
        lineHeight: 26,
        marginBottom: 10,
        marginTop: 4,
      },
      h3: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 17,
        lineHeight: 23,
        marginBottom: 8,
        marginTop: 2,
      },
      h4: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 15,
        lineHeight: 21,
        marginBottom: 7,
        marginTop: 2,
      },
      h5: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 14,
        lineHeight: 20,
        marginBottom: 6,
      },
      h6: {
        color: colors.textSecondary,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 12,
        lineHeight: 18,
        marginBottom: 6,
      },
      blockquote: {
        color: colors.textSecondary,
        fontFamily: guiFontFamilies.regular,
        borderColor: colors.primary,
        borderWidth: 3,
        gapWidth: 12,
        backgroundColor: colors.surface,
        marginBottom: 12,
        marginTop: 2,
      },
      list: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        bulletColor: colors.primary,
        markerColor: colors.primary,
        markerFontWeight: '600',
        markerMinWidth: 20,
        gapWidth: 7,
        fontSize: 14,
        lineHeight: 22,
        marginBottom: 10,
      },
      link: {
        color: colors.link,
        fontFamily: guiFontFamilies.medium,
        underline: true,
      },
      strong: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
      },
      em: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        fontStyle: 'italic',
      },
      code: {
        color: colors.text,
        backgroundColor: colors.surfaceRaised,
        borderColor: colors.divider,
        fontSize: 12,
      },
      codeBlock: {
        color: colors.text,
        backgroundColor: colors.sidebar,
        borderColor: colors.divider,
        borderRadius: 10,
        borderWidth: 1,
        fontFamily: guiFontFamilies.mono,
        fontSize: 12,
        lineHeight: 18,
        padding: 13,
        marginBottom: 14,
        marginTop: 2,
      },
      image: { borderRadius: 10, marginBottom: 12, marginTop: 2 },
      thematicBreak: {
        color: colors.divider,
        height: 1,
        marginBottom: 14,
        marginTop: 4,
      },
      table: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        borderColor: colors.divider,
        borderRadius: 10,
        borderWidth: 1,
        cellPaddingHorizontal: 10,
        cellPaddingVertical: 8,
        headerBackgroundColor: colors.surfaceRaised,
        headerFontFamily: guiFontFamilies.semiBold,
        headerTextColor: colors.text,
        rowEvenBackgroundColor: colors.surface,
        rowOddBackgroundColor: colors.canvas,
        fontSize: 13,
        lineHeight: 19,
        marginBottom: 14,
      },
      taskList: {
        checkedColor: colors.primary,
        borderColor: colors.divider,
        checkboxBorderRadius: 4,
        checkboxSize: 17,
        checkmarkColor: colors.onPrimary,
        checkedTextColor: colors.textSecondary,
      },
      ...(variant === 'transcript' ? {
        math: {
          color: colors.text,
          backgroundColor: 'transparent',
          fontSize: 17,
          padding: 4,
          marginBottom: 10,
          textAlign: 'center' as const,
        },
        inlineMath: {
          color: colors.text,
        },
      } : {}),
    }),
    [colors, variant],
  );
}

export function MarkdownText({
  content,
  containerStyle,
  onLinkPress,
  selectable = true,
  variant = 'default',
}: Props) {
  const markdownStyle = useWhipMarkdownStyle(variant);
  const markdown = useMemo(() => normalizeRichTextMarkdown(content), [content]);
  return (
    <EnrichedMarkdownText
      allowTrailingMargin={false}
      containerStyle={containerStyle}
      flavor="github"
      markdown={markdown}
      markdownStyle={markdownStyle}
      md4cFlags={{ latexMath: true }}
      onLinkPress={onLinkPress}
      selectable={selectable}
    />
  );
}
