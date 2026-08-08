import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  markdownImageTargets,
  resolveRemoteMarkdownPath,
  rewriteMarkdownImages,
} from '@/src/lib/markdownRemoteLinks';
import { parentRemotePath, remoteEntryName, remotePreviewKind } from '@/src/lib/remoteFiles';
import type { HerdrClient } from '@/src/services/HerdrClient';
import { cacheRemoteFile, type CachedRemoteFile } from '@/src/services/remoteFileTransfer';
import { useTheme } from '@/src/theme';

interface Props {
  client: HerdrClient;
  content: string;
  remotePath: string;
  onOpenRemotePath: (path: string) => Promise<void>;
}

const MAX_REMOTE_MARKDOWN_IMAGES = 24;
const MAX_REMOTE_MARKDOWN_IMAGE_BYTES = 50 * 1024 * 1024;

export function MarkdownPreview({ client, content, remotePath, onOpenRemotePath }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [localImages, setLocalImages] = useState<Record<string, string>>({});
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

  useEffect(() => {
    let disposed = false;
    const cachedFiles: CachedRemoteFile[] = [];
    setLocalImages({});
    const loadImages = async () => {
      let remainingBytes = MAX_REMOTE_MARKDOWN_IMAGE_BYTES;
      const directoryListings = new Map<string, Awaited<ReturnType<HerdrClient['listRemoteDirectory']>>>();
      const targets = [...new Set(markdownImageTargets(content).map(image => image.target))]
        .slice(0, MAX_REMOTE_MARKDOWN_IMAGES);
      for (const target of targets) {
        const path = resolveRemoteMarkdownPath(remotePath, target);
        if (!path) continue;
        try {
          const directory = parentRemotePath(path);
          let listing = directoryListings.get(directory);
          if (!listing) {
            listing = await client.listRemoteDirectory(directory);
            directoryListings.set(directory, listing);
          }
          const filename = path.slice(path.lastIndexOf('/') + 1);
          const entry = listing.entries.find(candidate => remoteEntryName(candidate) === filename);
          if (!entry || entry.isDirectory || remotePreviewKind(filename, entry.fileSize) !== 'image') continue;
          if (entry.fileSize > remainingBytes) continue;
          remainingBytes -= entry.fileSize;
          const cached = await cacheRemoteFile(client, path);
          if (disposed) {
            cached.dispose();
            return;
          }
          cachedFiles.push(cached);
          setLocalImages(current => ({ ...current, [target]: cached.uri }));
        } catch {
          // Leave an unavailable image unchanged so the renderer can show its alt text.
        }
      }
    };
    loadImages();
    return () => {
      disposed = true;
      for (const cached of cachedFiles) cached.dispose();
    };
  }, [client, content, remotePath]);

  const renderedContent = useMemo(
    () => rewriteMarkdownImages(content, target => localImages[target]),
    [content, localImages],
  );

  const openLink = ({ url }: { url: string }) => {
    const path = resolveRemoteMarkdownPath(remotePath, url);
    if (path) {
      onOpenRemotePath(path).catch(reason => {
        Alert.alert(t('files.linkFailed'), String(reason));
      });
      return;
    }
    Linking.openURL(url).catch(reason => {
      Alert.alert(t('files.linkFailed'), String(reason));
    });
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={styles.scrollContent}>
      <EnrichedMarkdownText
        containerStyle={styles.markdown}
        flavor="github"
        markdown={renderedContent}
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
