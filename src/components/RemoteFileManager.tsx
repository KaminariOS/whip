import type { LsResult } from '@dylankenneally/react-native-ssh-sftp';
import {
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Image, Modal, PanResponder, Pressable, ScrollView, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import {
  formatRemoteFileSize,
  joinRemotePath,
  parentRemotePath,
  remoteEntryName,
  remotePreviewKind,
  sortRemoteEntries,
  type RemoteFileSortDirection,
  type RemoteFileSortField,
  type RemotePreviewKind,
} from '@/src/lib/remoteFiles';
import {
  REMOTE_FILE_SWIPE_ACTION_WIDTH,
  remoteFileSwipeOffset,
  shouldClaimRemoteFileSwipe,
  shouldOpenRemoteFileSwipe,
} from '@/src/lib/remoteFileSwipeActions';
import type { HerdrClient, RemoteHtmlPreviewHandle } from '@/src/services/HerdrClient';
import {
  cacheRemoteFile,
  copyCachedRemoteFileToPickedDirectory,
  pickLocalFileForUpload,
  saveCachedRemoteText,
  type CachedRemoteFile,
} from '@/src/services/remoteFileTransfer';
import { useTheme } from '@/src/theme';
import { hapticPress } from './app-ui';
import { CodeEditor, CodePreview } from './CodePreview';
import { HtmlPreview } from './HtmlPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { RemoteVideoPreview } from './RemoteVideoPreview';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  visible: boolean;
  client: HerdrClient;
  initialPath: string;
  onPathChange: (path: string) => void;
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
  htmlPreview: RemoteHtmlPreviewHandle | null;
  htmlRevision: number;
}

const remoteFileSortFields: RemoteFileSortField[] = ['name', 'modified', 'size'];
const remoteFileSortDirections: RemoteFileSortDirection[] = ['ascending', 'descending'];

export function RemoteFileManager({ visible, client, initialPath, onPathChange, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const safeAreaInsets = useSafeAreaInsets();
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<LsResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [sortField, setSortField] = useState<RemoteFileSortField>('name');
  const [sortDirection, setSortDirection] = useState<RemoteFileSortDirection>('ascending');
  const [sortMenuVisible, setSortMenuVisible] = useState(false);
  const previewRef = useRef<FilePreview | null>(null);
  const pathRef = useRef('');
  const requestRef = useRef(0);
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;
  const sortedEntries = useMemo(
    () => sortRemoteEntries(entries, sortField, sortDirection),
    [entries, sortDirection, sortField],
  );

  const replacePreview = useCallback((next: FilePreview | null) => {
    const previous = previewRef.current;
    if (previous?.cached && previous.cached !== next?.cached) previous.cached.dispose();
    if (previous?.htmlPreview && previous.htmlPreview !== next?.htmlPreview) {
      client.closeRemoteHtmlPreview(previous.htmlPreview).catch(() => undefined);
    }
    previewRef.current = next;
    setPreview(next);
  }, [client]);

  const loadDirectory = useCallback(async (requestedPath: string) => {
    const request = ++requestRef.current;
    setBusy(true);
    setError(null);
    replacePreview(null);
    try {
      const listing = await client.listRemoteDirectory(requestedPath);
      if (request !== requestRef.current) return;
      pathRef.current = listing.path;
      setPath(listing.path);
      setEntries(listing.entries);
      onPathChangeRef.current(listing.path);
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
    const current = previewRef.current;
    current?.cached?.dispose();
    if (current?.htmlPreview) client.closeRemoteHtmlPreview(current.htmlPreview).catch(() => undefined);
    previewRef.current = null;
  }, [client]);

  const openEntry = async (entry: LsResult, directoryPath = path) => {
    const name = remoteEntryName(entry);
    const entryPath = joinRemotePath(directoryPath, name);
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
      htmlPreview: null,
      htmlRevision: 0,
    };
    replacePreview(loadingPreview);
    if (kind === 'unsupported') return;

    let cached: CachedRemoteFile | null = null;
    let htmlPreview: RemoteHtmlPreviewHandle | null = null;
    try {
      cached = await cacheRemoteFile(client, entryPath);
      const content = isTextPreview(kind) ? await cached.file.text() : null;
      if (request !== requestRef.current) {
        cached.dispose();
        return;
      }
      if (kind === 'html') htmlPreview = await client.openRemoteHtmlPreview(entryPath);
      if (request !== requestRef.current) {
        cached.dispose();
        if (htmlPreview) await client.closeRemoteHtmlPreview(htmlPreview).catch(() => undefined);
        return;
      }
      replacePreview({ ...loadingPreview, cached, content, draft: content || '', htmlPreview });
    } catch (reason) {
      cached?.dispose();
      if (htmlPreview) await client.closeRemoteHtmlPreview(htmlPreview).catch(() => undefined);
      if (request === requestRef.current) {
        replacePreview({ ...loadingPreview, error: String(reason) });
      }
    }
  };

  const openRemotePath = async (remotePath: string) => {
    const request = ++requestRef.current;
    const directory = parentRemotePath(remotePath);
    const filename = remotePath.slice(remotePath.lastIndexOf('/') + 1);
    const listing = await client.listRemoteDirectory(directory);
    if (request !== requestRef.current) return;
    const entry = listing.entries.find(candidate => remoteEntryName(candidate) === filename);
    if (!entry) throw new Error(`Remote file not found: ${remotePath}`);
    await openEntry(entry, listing.path);
  };

  const dismissNow = () => {
    requestRef.current += 1;
    setSortMenuVisible(false);
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
      updatePreview({
        content: current.draft,
        editing: false,
        htmlRevision: current.htmlRevision + 1,
      });
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

  const deleteEntry = async (entry: LsResult, directoryPath: string) => {
    const name = remoteEntryName(entry);
    const entryPath = joinRemotePath(directoryPath, name);
    setDeletingPath(entryPath);
    try {
      await client.deleteRemoteEntry(entryPath, Boolean(entry.isDirectory));
      if (pathRef.current === directoryPath) {
        setEntries(current => current.filter(candidate => remoteEntryName(candidate) !== name));
      }
    } catch (reason) {
      Alert.alert(t('files.deleteFailed', { name }), String(reason));
    } finally {
      setDeletingPath(null);
    }
  };

  const confirmDeleteEntry = (entry: LsResult) => {
    const name = remoteEntryName(entry);
    const directoryPath = path;
    Alert.alert(
      t('files.deleteTitle', { name }),
      t(entry.isDirectory ? 'files.deleteDirectoryCopy' : 'files.deleteFileCopy'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => { deleteEntry(entry, directoryPath); },
        },
      ],
    );
  };

  const previewLoading = preview && preview.kind !== 'unsupported' && !preview.cached && !preview.error;
  const canEdit = preview && isTextPreview(preview.kind) && Boolean(preview.cached) && preview.content !== null;

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => sortMenuVisible
        ? setSortMenuVisible(false)
        : confirmDiscard(preview ? closePreviewNow : dismissNow)}
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
              <CodeEditor
                editable={!actionBusy}
                filename={remoteEntryName(preview.entry)}
                onChangeText={draft => updatePreview({ draft })}
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
            ) : preview.kind === 'video' && preview.cached ? (
              <RemoteVideoPreview
                filename={remoteEntryName(preview.entry)}
                uri={preview.cached.uri}
              />
            ) : preview.kind === 'markdown' ? (
              <MarkdownPreview
                key={preview.path}
                client={client}
                content={preview.content || ''}
                onOpenRemotePath={openRemotePath}
                remotePath={preview.path}
              />
            ) : preview.kind === 'html' && preview.htmlPreview ? (
              <HtmlPreview
                filename={remoteEntryName(preview.entry)}
                revision={preview.htmlRevision}
                uri={preview.htmlPreview.url}
              />
            ) : preview.kind === 'code' ? (
              <CodePreview content={preview.content || ''} filename={remoteEntryName(preview.entry)} />
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
              <Button accessibilityLabel={t('files.sort')} className="h-12 w-12 rounded-none px-0" disabled={busy || actionBusy} variant="ghost" onPress={hapticPress(() => setSortMenuVisible(true))}>
                <ArrowUpDown size={18} color={colors.text} />
              </Button>
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
                {sortedEntries.map(entry => {
                  const name = remoteEntryName(entry);
                  const directory = Boolean(entry.isDirectory);
                  const kind = remotePreviewKind(name, entry.fileSize);
                  return (
                    <SwipeableRemoteFileRow
                      key={`${name}-${entry.flags}`}
                      deleting={deletingPath === joinRemotePath(path, name)}
                      disabled={Boolean(deletingPath)}
                      name={name}
                      onDelete={() => confirmDeleteEntry(entry)}>
                      {({ actionsOpen, closeActions }) => (
                        <Button
                          accessibilityLabel={t(directory ? 'files.openDirectory' : 'files.openFile', { name })}
                          className="h-auto min-h-[62px] justify-start gap-3 rounded-none bg-background px-2 py-2"
                          disabled={Boolean(deletingPath)}
                          variant="ghost"
                          onPress={hapticPress(() => {
                            if (actionsOpen) closeActions();
                            else openEntry(entry);
                          })}>
                          <View className="size-9 items-center justify-center rounded-lg bg-muted">
                            {directory
                              ? <Folder size={18} color={colors.primary} />
                              : kind === 'image'
                                ? <ImageIcon size={18} color={colors.textSecondary} />
                                : kind === 'video'
                                  ? <FileVideo size={18} color={colors.textSecondary} />
                                : kind === 'code' || kind === 'html'
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
                      )}
                    </SwipeableRemoteFileRow>
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
        {sortMenuVisible ? (
          <View className="absolute inset-0 z-50 justify-end">
            <Pressable accessibilityLabel={t('common.close')} className="absolute inset-0 bg-black/55" onPress={() => setSortMenuVisible(false)} />
            <View className="rounded-t-[22px] border-t border-border bg-card px-4 pt-4" style={{ paddingBottom: Math.max(16, safeAreaInsets.bottom) }}>
              <View className="mb-3 flex-row items-center">
                <Text className="min-w-0 flex-1 text-[18px] font-semibold text-foreground">{t('files.sortBy')}</Text>
                <Button accessibilityLabel={t('common.close')} className="size-10 rounded-full px-0" variant="ghost" onPress={() => setSortMenuVisible(false)}>
                  <X size={19} color={colors.text} />
                </Button>
              </View>
              <View className="overflow-hidden rounded-lg border border-border">
                {remoteFileSortFields.map((field, index) => {
                  const selected = field === sortField;
                  return (
                    <Button
                      key={field}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      className={index === 0 ? 'min-h-12 justify-start rounded-none px-3.5' : 'min-h-12 justify-start rounded-none border-t border-border px-3.5'}
                      variant={selected ? 'secondary' : 'ghost'}
                      onPress={hapticPress(() => setSortField(field))}>
                      <Text className="flex-1 text-left text-sm font-medium">{t(`files.sort.${field}`)}</Text>
                      {selected ? <Check size={18} color={colors.primary} /> : null}
                    </Button>
                  );
                })}
              </View>
              <Text className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[1px] text-muted-foreground">{t('files.sortOrder')}</Text>
              <View className="flex-row overflow-hidden rounded-lg border border-border">
                {remoteFileSortDirections.map((direction, index) => {
                  const selected = direction === sortDirection;
                  return (
                    <Button
                      key={direction}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      className={index === 0 ? 'min-h-12 flex-1 rounded-none px-3' : 'min-h-12 flex-1 rounded-none border-l border-border px-3'}
                      variant={selected ? 'secondary' : 'ghost'}
                      onPress={hapticPress(() => setSortDirection(direction))}>
                      <Text className="text-sm font-medium">{t(`files.sort.${direction}`)}</Text>
                    </Button>
                  );
                })}
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function SwipeableRemoteFileRow({
  children,
  deleting,
  disabled,
  name,
  onDelete,
}: {
  children: (controls: { actionsOpen: boolean; closeActions: () => void }) => ReactNode;
  deleting: boolean;
  disabled: boolean;
  name: string;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const translateX = useSharedValue(0);
  const openRef = useRef(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const actionRevealStyle = useAnimatedStyle(() => ({
    width: Math.max(0, -translateX.value),
  }));

  const settle = (open: boolean) => {
    openRef.current = open;
    setActionsOpen(open);
    translateX.value = withSpring(open ? -REMOTE_FILE_SWIPE_ACTION_WIDTH : 0, {
      damping: 24,
      stiffness: 260,
      mass: 0.8,
      overshootClamping: true,
    });
  };

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => (
      shouldClaimRemoteFileSwipe(gesture.dx, gesture.dy, openRef.current)
    ),
    onPanResponderGrant: () => cancelAnimation(translateX),
    onPanResponderMove: (_event, gesture) => {
      translateX.value = remoteFileSwipeOffset(gesture.dx, openRef.current);
    },
    onPanResponderRelease: (_event, gesture) => {
      settle(shouldOpenRemoteFileSwipe(gesture.dx, gesture.vx, openRef.current));
    },
    onPanResponderTerminate: () => settle(openRef.current),
    onPanResponderTerminationRequest: () => false,
  })).current;

  const runDelete = () => {
    settle(false);
    onDelete();
  };

  return (
    <View className="relative min-h-[62px] overflow-hidden border-b border-border">
      <Animated.View
        accessibilityElementsHidden={!actionsOpen}
        className="absolute inset-y-0 right-0 overflow-hidden"
        importantForAccessibility={actionsOpen ? 'auto' : 'no-hide-descendants'}
        style={actionRevealStyle}>
        <Button
          accessibilityLabel={t('files.deleteEntry', { name })}
          className="absolute inset-y-0 right-0 h-full w-[84px] flex-col gap-1 rounded-none"
          disabled={disabled}
          size="content"
          variant="destructive"
          onPress={hapticPress(runDelete)}>
          {deleting
            ? <ActivityIndicator color="white" size="small" />
            : <Icon as={Trash2} className="text-destructive-foreground" size={19} />}
          <Text className="text-[11px] font-semibold">{t('common.delete')}</Text>
        </Button>
      </Animated.View>
      <Animated.View style={animatedStyle} {...panResponder.panHandlers}>
        {children({ actionsOpen, closeActions: () => settle(false) })}
      </Animated.View>
    </View>
  );
}

function isTextPreview(kind: RemotePreviewKind): boolean {
  return kind === 'code' || kind === 'html' || kind === 'markdown' || kind === 'text';
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
