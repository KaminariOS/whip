import type { LsResult } from '@dylankenneally/react-native-ssh-sftp';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import {
  formatRemoteFileSize,
  joinRemotePath,
  parentRemotePath,
  remoteEntryName,
  remotePreviewKind,
  type RemotePreviewKind,
} from '@/src/lib/remoteFiles';
import type { HerdrClient } from '@/src/services/HerdrClient';
import {
  cacheRemoteFile,
  copyCachedRemoteFileToPickedDirectory,
  pickLocalFileForUpload,
  saveCachedRemoteText,
  type CachedRemoteFile,
} from '@/src/services/remoteFileTransfer';
import { useTheme } from '@/src/theme';
import { hapticPress } from './app-ui';
import { MarkdownPreview } from './MarkdownPreview';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  visible: boolean;
  client: HerdrClient;
  initialPath: string;
  onClose: () => void;
}

interface FilePreview {
  entry: LsResult;
  path: string;
  kind: RemotePreviewKind;
  cached: CachedRemoteFile | null;
  content: string | null;
  draft: string;
  editing: boolean;
  error: string | null;
}

export function RemoteFileManager({ visible, client, initialPath, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const safeAreaInsets = useSafeAreaInsets();
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<LsResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const previewRef = useRef<FilePreview | null>(null);
  const requestRef = useRef(0);

  const replacePreview = useCallback((next: FilePreview | null) => {
    const previous = previewRef.current;
    if (previous?.cached && previous.cached !== next?.cached) previous.cached.dispose();
    previewRef.current = next;
    setPreview(next);
  }, []);

  const loadDirectory = useCallback(async (requestedPath: string) => {
    const request = ++requestRef.current;
    setBusy(true);
    setError(null);
    replacePreview(null);
    try {
      const listing = await client.listRemoteDirectory(requestedPath);
      if (request !== requestRef.current) return;
      setPath(listing.path);
      setEntries(listing.entries);
    } catch (reason) {
      if (request === requestRef.current) setError(String(reason));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }, [client, replacePreview]);

  useEffect(() => {
    if (visible) loadDirectory(initialPath);
    else {
      requestRef.current += 1;
      replacePreview(null);
    }
  }, [initialPath, loadDirectory, replacePreview, visible]);

  useEffect(() => () => {
    previewRef.current?.cached?.dispose();
    previewRef.current = null;
  }, []);

  const openEntry = async (entry: LsResult) => {
    const name = remoteEntryName(entry);
    const entryPath = joinRemotePath(path, name);
    if (entry.isDirectory) {
      await loadDirectory(entryPath);
      return;
    }

    const kind = remotePreviewKind(name, entry.fileSize);
    const request = ++requestRef.current;
    const loadingPreview: FilePreview = {
      entry,
      path: entryPath,
      kind,
      cached: null,
      content: null,
      draft: '',
      editing: false,
      error: null,
    };
    replacePreview(loadingPreview);
    if (kind === 'unsupported') return;

    let cached: CachedRemoteFile | null = null;
    try {
      cached = await cacheRemoteFile(client, entryPath);
      const content = isTextPreview(kind) ? await cached.file.text() : null;
      if (request !== requestRef.current) {
        cached.dispose();
        return;
      }
      replacePreview({ ...loadingPreview, cached, content, draft: content || '' });
    } catch (reason) {
      cached?.dispose();
      if (request === requestRef.current) {
        replacePreview({ ...loadingPreview, error: String(reason) });
      }
    }
  };

  const dismissNow = () => {
    requestRef.current += 1;
    replacePreview(null);
    onClose();
  };

  const closePreviewNow = () => {
    requestRef.current += 1;
    replacePreview(null);
  };

  const confirmDiscard = (action: () => void) => {
    const current = previewRef.current;
    if (!current?.editing || current.draft === current.content) {
      action();
      return;
    }
    Alert.alert(t('files.discardTitle'), t('files.discardCopy'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('files.discard'), style: 'destructive', onPress: action },
    ]);
  };

  const updatePreview = (updates: Partial<FilePreview>) => {
    const current = previewRef.current;
    if (current) replacePreview({ ...current, ...updates });
  };

  const savePreview = async () => {
    const current = previewRef.current;
    if (!current?.cached || !isTextPreview(current.kind)) return;
    setActionBusy(true);
    try {
      await saveCachedRemoteText(client, current.cached, parentRemotePath(current.path), current.draft);
      updatePreview({ content: current.draft, editing: false });
      Alert.alert(t('files.savedTitle'), t('files.savedCopy', { name: remoteEntryName(current.entry) }));
    } catch (reason) {
      Alert.alert(t('files.saveFailed'), String(reason));
    } finally {
      setActionBusy(false);
    }
  };

  const downloadPreview = async () => {
    const current = previewRef.current;
    if (!current) return;
    setActionBusy(true);
    let cached = current.cached;
    let temporary = false;
    try {
      if (!cached) {
        cached = await cacheRemoteFile(client, current.path);
        temporary = true;
      }
      const destination = await copyCachedRemoteFileToPickedDirectory(cached);
      Alert.alert(t('files.downloadedTitle'), t('files.downloadedCopy', {
        name: remoteEntryName(current.entry),
        destination,
      }));
    } catch (reason) {
      if (!isPickerCancellation(reason)) Alert.alert(t('files.downloadFailed'), String(reason));
    } finally {
      if (temporary) cached?.dispose();
      setActionBusy(false);
    }
  };

  const uploadFile = async () => {
    setActionBusy(true);
    let picked: Awaited<ReturnType<typeof pickLocalFileForUpload>> = null;
    try {
      picked = await pickLocalFileForUpload();
      if (!picked) return;
      await client.uploadRemoteFile(picked.nativePath, path);
      const uploadedName = picked.name;
      await loadDirectory(path);
      Alert.alert(t('files.uploadedTitle'), t('files.uploadedCopy', { name: uploadedName }));
    } catch (reason) {
      Alert.alert(t('files.uploadFailed'), String(reason));
    } finally {
      picked?.dispose();
      setActionBusy(false);
    }
  };

  const previewLoading = preview && preview.kind !== 'unsupported' && !preview.cached && !preview.error;
  const canEdit = preview && isTextPreview(preview.kind) && Boolean(preview.cached) && preview.content !== null;

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => confirmDiscard(preview ? closePreviewNow : dismissNow)}
      statusBarTranslucent
      visible={visible}>
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: safeAreaInsets.top, paddingBottom: safeAreaInsets.bottom }}>
        {preview ? (
          <>
            <View className="h-14 flex-row items-center border-b border-border bg-background">
              <Button accessibilityLabel={t('files.backToDirectory')} className="h-14 w-11 rounded-none px-0" variant="ghost" onPress={() => confirmDiscard(closePreviewNow)}>
                <ChevronLeft size={21} color={colors.text} />
              </Button>
              <View className="min-w-0 flex-1 px-1">
                <Text numberOfLines={1} className="text-[14px] font-bold text-foreground">{remoteEntryName(preview.entry)}</Text>
                <Text numberOfLines={1} className="font-mono text-[8px] text-muted-foreground">{preview.path}</Text>
              </View>
              {canEdit && (preview.editing ? (
                <>
                  <Button accessibilityLabel={t('files.cancelEdit')} className="h-14 w-11 rounded-none px-0" disabled={actionBusy} variant="ghost" onPress={() => updatePreview({ editing: false, draft: preview.content || '' })}>
                    <X size={18} color={colors.textSecondary} />
                  </Button>
                  <Button accessibilityLabel={t('files.save')} className="h-14 w-11 rounded-none px-0" disabled={actionBusy} variant="ghost" onPress={hapticPress(savePreview)}>
                    {actionBusy ? <ActivityIndicator size="small" color={colors.primary} /> : <Check size={19} color={colors.primary} />}
                  </Button>
                </>
              ) : (
                <Button accessibilityLabel={t('files.edit')} className="h-14 w-11 rounded-none px-0" disabled={actionBusy} variant="ghost" onPress={hapticPress(() => updatePreview({ editing: true }))}>
                  <Pencil size={17} color={colors.text} />
                </Button>
              ))}
              {!preview.editing && (
                <Button accessibilityLabel={t('files.download')} className="h-14 w-11 rounded-none px-0" disabled={actionBusy} variant="ghost" onPress={hapticPress(downloadPreview)}>
                  {actionBusy ? <ActivityIndicator size="small" color={colors.primary} /> : <Download size={18} color={colors.text} />}
                </Button>
              )}
              <Button accessibilityLabel={t('files.close')} className="h-14 w-11 rounded-none px-0" variant="ghost" onPress={() => confirmDiscard(dismissNow)}>
                <X size={19} color={colors.text} />
              </Button>
            </View>
            {preview.editing ? (
              <Input
                autoCapitalize="none"
                autoCorrect={false}
                className="h-auto flex-1 rounded-none border-0 bg-terminal-canvas p-4 font-mono text-[12px] leading-[18px] text-terminal-text"
                editable={!actionBusy}
                multiline
                onChangeText={draft => updatePreview({ draft })}
                textAlignVertical="top"
                value={preview.draft}
              />
            ) : preview.kind === 'unsupported' ? (
              <View className="flex-1 items-center justify-center p-8">
                <FileText size={30} color={colors.textSecondary} />
                <Text className="mt-4 text-center text-[15px] font-semibold">{t('files.previewUnavailable')}</Text>
                <Text className="mt-2 text-center text-[12px] leading-[18px] text-muted-foreground">
                  {t('files.previewUnavailableCopy', { size: formatRemoteFileSize(preview.entry.fileSize) })}
                </Text>
              </View>
            ) : preview.error ? (
              <View className="flex-1 items-center justify-center p-8">
                <Text className="text-center text-[14px] font-semibold text-destructive">{t('files.openFailed')}</Text>
                <Text className="mt-2 text-center font-mono text-[9px] leading-[14px] text-muted-foreground">{preview.error}</Text>
                <Button className="mt-5 rounded-full" variant="secondary" onPress={hapticPress(() => openEntry(preview.entry))}>
                  <RefreshCw size={16} color={colors.text} />
                  <Text>{t('files.retry')}</Text>
                </Button>
              </View>
            ) : previewLoading ? (
              <View className="flex-1 items-center justify-center gap-3 p-8">
                <ActivityIndicator color={colors.primary} />
                <Text className="text-[12px] text-muted-foreground">{t('files.opening')}</Text>
              </View>
            ) : preview.kind === 'image' && preview.cached ? (
              <View className="flex-1 bg-terminal-canvas p-3">
                <Image accessibilityLabel={remoteEntryName(preview.entry)} className="flex-1" resizeMode="contain" source={{ uri: preview.cached.uri }} />
              </View>
            ) : preview.kind === 'markdown' ? (
              <MarkdownPreview content={preview.content || ''} />
            ) : (
              <ScrollView className="flex-1 bg-terminal-canvas" contentContainerClassName="p-4">
                <ScrollView horizontal>
                  <Text selectable className="font-mono text-[11px] leading-[17px] text-terminal-text">{preview.content || ' '}</Text>
                </ScrollView>
              </ScrollView>
            )}
          </>
        ) : (
          <>
            <View className="h-14 flex-row items-center border-b border-border bg-background px-1">
              <View className="size-11 items-center justify-center">
                <FolderOpen size={20} color={colors.text} />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-[17px] font-bold text-foreground">{t('files.title')}</Text>
                <Text className="font-mono text-[8px] uppercase tracking-[1px] text-muted-foreground">{t('files.remote')}</Text>
              </View>
              <Button accessibilityLabel={t('files.close')} className="size-11 rounded-full px-0" variant="ghost" onPress={dismissNow}>
                <X size={19} color={colors.text} />
              </Button>
            </View>
            <View className="h-12 flex-row items-center border-b border-border bg-card">
              <Button accessibilityLabel={t('files.parentDirectory')} className="h-12 w-12 rounded-none px-0" disabled={!path || path === '/' || busy || actionBusy} variant="ghost" onPress={hapticPress(() => loadDirectory(parentRemotePath(path)))}>
                <ChevronLeft size={20} color={colors.text} />
              </Button>
              <Text numberOfLines={1} className="min-w-0 flex-1 font-mono text-[10px] text-foreground">{path || initialPath}</Text>
              <Button accessibilityLabel={t('files.upload')} className="h-12 w-12 rounded-none px-0" disabled={busy || actionBusy || !path} variant="ghost" onPress={hapticPress(uploadFile)}>
                {actionBusy ? <ActivityIndicator size="small" color={colors.primary} /> : <Upload size={18} color={colors.text} />}
              </Button>
              <Button accessibilityLabel={t('files.refresh')} className="h-12 w-12 rounded-none px-0" disabled={busy || actionBusy} variant="ghost" onPress={hapticPress(() => loadDirectory(path || initialPath))}>
                <RefreshCw size={18} color={colors.text} />
              </Button>
            </View>
            {busy ? (
              <View className="flex-1 items-center justify-center gap-3 p-8">
                <ActivityIndicator color={colors.primary} />
                <Text className="text-[12px] text-muted-foreground">{t('files.loading')}</Text>
              </View>
            ) : error ? (
              <View className="flex-1 items-center justify-center p-8">
                <Text className="text-center text-[14px] font-semibold text-destructive">{t('files.listFailed')}</Text>
                <Text className="mt-2 text-center font-mono text-[9px] leading-[14px] text-muted-foreground">{error}</Text>
                <Button className="mt-5 rounded-full" variant="secondary" onPress={hapticPress(() => loadDirectory(path || initialPath))}>
                  <RefreshCw size={16} color={colors.text} />
                  <Text>{t('files.retry')}</Text>
                </Button>
              </View>
            ) : entries.length ? (
              <ScrollView className="flex-1" contentContainerClassName="px-3 py-1">
                {entries.map(entry => {
                  const name = remoteEntryName(entry);
                  const directory = Boolean(entry.isDirectory);
                  const kind = remotePreviewKind(name, entry.fileSize);
                  return (
                    <Button
                      key={`${name}-${entry.flags}`}
                      accessibilityLabel={t(directory ? 'files.openDirectory' : 'files.openFile', { name })}
                      className="h-auto min-h-[62px] justify-start gap-3 rounded-none border-b border-border px-2 py-2"
                      variant="ghost"
                      onPress={hapticPress(() => openEntry(entry))}>
                      <View className="size-9 items-center justify-center rounded-lg bg-muted">
                        {directory
                          ? <Folder size={18} color={colors.primary} />
                          : kind === 'image'
                            ? <ImageIcon size={18} color={colors.textSecondary} />
                            : kind === 'code'
                              ? <FileCode2 size={18} color={colors.textSecondary} />
                              : <FileText size={18} color={colors.textSecondary} />}
                      </View>
                      <View className="min-w-0 flex-1 items-start">
                        <Text numberOfLines={1} className="text-left text-[13px] font-semibold text-foreground">{name}</Text>
                        <Text numberOfLines={1} className="mt-0.5 font-mono text-[8px] text-muted-foreground">
                          {directory ? t('files.directory') : formatRemoteFileSize(entry.fileSize)}
                          {formatRemoteModificationDate(entry.modificationDate) ? ` · ${formatRemoteModificationDate(entry.modificationDate)}` : ''}
                        </Text>
                      </View>
                      <ChevronRight size={17} color={colors.textTertiary} />
                    </Button>
                  );
                })}
              </ScrollView>
            ) : (
              <View className="flex-1 items-center justify-center p-8">
                <FolderOpen size={30} color={colors.textSecondary} />
                <Text className="mt-4 text-[15px] font-semibold">{t('files.empty')}</Text>
              </View>
            )}
          </>
        )}
      </View>
    </Modal>
  );
}

function isTextPreview(kind: RemotePreviewKind): boolean {
  return kind === 'code' || kind === 'markdown' || kind === 'text';
}

function isPickerCancellation(reason: unknown): boolean {
  const message = String(reason).toLowerCase();
  return message.includes('cancel') || message.includes('dismiss');
}

function formatRemoteModificationDate(value: string): string {
  if (!value) return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}
