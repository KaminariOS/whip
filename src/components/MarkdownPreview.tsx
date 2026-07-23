import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';
import { useMemo } from 'react';
import { Alert, Linking, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/src/theme';

export function MarkdownPreview({ content }: { content: string }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const markdownStyle = useMemo<MarkdownStyle>(() => ({
    paragraph: { color: colors.text, fontSize: 14, lineHeight: 22, marginBottom: 12 },
    h1: { color: colors.text, fontSize: 26, lineHeight: 32, marginBottom: 14 },
    h2: { color: colors.text, fontSize: 22, lineHeight: 28, marginBottom: 12 },
    h3: { color: colors.text, fontSize: 18, lineHeight: 24, marginBottom: 10 },
    h4: { color: colors.text, fontSize: 16, lineHeight: 22, marginBottom: 8 },
    h5: { color: colors.text, fontSize: 14, lineHeight: 20, marginBottom: 8 },
    h6: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 8 },
    blockquote: {
      color: colors.textSecondary,
      borderColor: colors.primary,
      borderWidth: 2,
      gapWidth: 12,
      backgroundColor: colors.surface,
      marginBottom: 12,
    },
    list: {
      color: colors.text,
      bulletColor: colors.primary,
      markerColor: colors.primary,
      fontSize: 14,
      lineHeight: 22,
      marginBottom: 8,
    },
    link: { color: colors.link, underline: true },
    code: {
      color: colors.text,
      backgroundColor: colors.surfaceRaised,
      borderColor: colors.divider,
      fontFamily: 'monospace',
      fontSize: 12,
    },
    codeBlock: {
      color: colors.text,
      backgroundColor: colors.sidebar,
      borderColor: colors.divider,
      borderRadius: 8,
      borderWidth: 1,
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 18,
      padding: 12,
      marginBottom: 14,
    },
    thematicBreak: { color: colors.divider, height: 1, marginBottom: 14, marginTop: 4 },
    table: {
      color: colors.text,
      borderColor: colors.divider,
      headerBackgroundColor: colors.surfaceRaised,
      headerTextColor: colors.text,
      rowEvenBackgroundColor: colors.surface,
      rowOddBackgroundColor: colors.canvas,
      fontSize: 13,
    },
    taskList: {
      checkedColor: colors.primary,
      borderColor: colors.divider,
      checkmarkColor: colors.onPrimary,
      checkedTextColor: colors.textSecondary,
    },
  }), [colors]);

  const openLink = ({ url }: { url: string }) => {
    Linking.openURL(url).catch(reason => {
      Alert.alert(t('files.linkFailed'), String(reason));
    });
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={styles.scrollContent}>
      <EnrichedMarkdownText
        containerStyle={styles.markdown}
        flavor="github"
        markdown={content}
        markdownStyle={markdownStyle}
        onLinkPress={openLink}
        selectable
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: { padding: 20 },
  markdown: { width: '100%' },
});
