import AsyncStorage from '@react-native-async-storage/async-storage';

const REMOTE_CONTENT_PROGRESS_PREFIX = 'whip.remote-content-progress.v1:';

export interface RemoteContentIdentity {
  hostId: string;
  remotePath: string;
  fileSize: number;
  modificationDate: string;
}

export interface RemoteMediaProgress {
  kind: 'media';
  positionSeconds: number;
  durationSeconds: number;
}

export interface RemoteTextProgress {
  kind: 'text';
  offsetX: number;
  offsetY: number;
  contentWidth: number;
  contentHeight: number;
}

export type RemoteContentProgress = RemoteMediaProgress | RemoteTextProgress;

interface StoredRemoteContentProgress {
  fileSize: number;
  modificationDate: string;
  updatedAt: number;
  progress: RemoteContentProgress;
}

export async function loadRemoteContentProgress(
  identity: RemoteContentIdentity,
): Promise<RemoteContentProgress | null> {
  try {
    const value = await AsyncStorage.getItem(remoteContentProgressKey(identity));
    if (!value) return null;
    const stored = JSON.parse(value) as Partial<StoredRemoteContentProgress>;
    if (
      stored.fileSize !== identity.fileSize
      || stored.modificationDate !== identity.modificationDate
      || !isRemoteContentProgress(stored.progress)
    ) {
      return null;
    }
    return stored.progress;
  } catch {
    return null;
  }
}

export async function saveRemoteContentProgress(
  identity: RemoteContentIdentity,
  progress: RemoteContentProgress,
): Promise<void> {
  const stored: StoredRemoteContentProgress = {
    fileSize: identity.fileSize,
    modificationDate: identity.modificationDate,
    updatedAt: Date.now(),
    progress,
  };
  await AsyncStorage.setItem(remoteContentProgressKey(identity), JSON.stringify(stored));
}

export async function clearRemoteContentProgress(
  identity: RemoteContentIdentity,
): Promise<void> {
  await AsyncStorage.removeItem(remoteContentProgressKey(identity));
}

export function shouldSaveMediaProgress(
  positionSeconds: number,
  durationSeconds: number,
): boolean {
  if (!isFiniteNonNegative(positionSeconds) || positionSeconds < 1) return false;
  if (!isFinitePositive(durationSeconds)) return true;
  const remainingSeconds = durationSeconds - positionSeconds;
  return remainingSeconds > 15 && positionSeconds / durationSeconds < 0.95;
}

export function remoteContentProgressKey(
  identity: Pick<RemoteContentIdentity, 'hostId' | 'remotePath'>,
): string {
  return `${REMOTE_CONTENT_PROGRESS_PREFIX}${encodeURIComponent(identity.hostId)}:${encodeURIComponent(identity.remotePath)}`;
}

function isRemoteContentProgress(value: unknown): value is RemoteContentProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Partial<RemoteContentProgress>;
  if (progress.kind === 'media') {
    const media = progress as Partial<RemoteMediaProgress>;
    return isFiniteNonNegative(media.positionSeconds) && isFiniteNonNegative(media.durationSeconds);
  }
  if (progress.kind === 'text') {
    const text = progress as Partial<RemoteTextProgress>;
    return isFiniteNonNegative(text.offsetX)
      && isFiniteNonNegative(text.offsetY)
      && isFiniteNonNegative(text.contentWidth)
      && isFiniteNonNegative(text.contentHeight);
  }
  return false;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return isFiniteNonNegative(value) && value > 0;
}
