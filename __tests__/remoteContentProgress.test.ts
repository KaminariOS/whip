import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearRemoteContentProgress,
  loadRemoteContentProgress,
  remoteContentProgressKey,
  saveRemoteContentProgress,
  shouldSaveMediaProgress,
  type RemoteContentIdentity,
} from '../src/services/remoteContentProgress';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    removeItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const identity: RemoteContentIdentity = {
  hostId: 'host:one',
  remotePath: '/srv/media/a file.mp4',
  fileSize: 1234,
  modificationDate: '2040',
};
const getItem = jest.mocked(AsyncStorage.getItem);
const removeItem = jest.mocked(AsyncStorage.removeItem);
const setItem = jest.mocked(AsyncStorage.setItem);

beforeEach(() => {
  jest.clearAllMocks();
});

it('keys progress by host and stable remote path', () => {
  expect(remoteContentProgressKey(identity)).toBe(
    'whip.remote-content-progress.v1:host%3Aone:%2Fsrv%2Fmedia%2Fa%20file.mp4',
  );
});

it('persists and loads progress when the remote fingerprint matches', async () => {
  const progress = {
    kind: 'media' as const,
    positionSeconds: 42,
    durationSeconds: 300,
  };
  await saveRemoteContentProgress(identity, progress);
  const stored = JSON.parse(setItem.mock.calls[0][1]);
  expect(stored).toMatchObject({
    fileSize: identity.fileSize,
    modificationDate: identity.modificationDate,
    progress,
  });

  getItem.mockResolvedValue(JSON.stringify(stored));
  await expect(loadRemoteContentProgress(identity)).resolves.toEqual(progress);
});

it('ignores stale, malformed, or unreadable progress', async () => {
  getItem.mockResolvedValue(JSON.stringify({
    fileSize: identity.fileSize + 1,
    modificationDate: identity.modificationDate,
    progress: { kind: 'text', offsetX: 0, offsetY: 100, contentWidth: 300, contentHeight: 1000 },
  }));
  await expect(loadRemoteContentProgress(identity)).resolves.toBeNull();

  getItem.mockResolvedValue('{not json');
  await expect(loadRemoteContentProgress(identity)).resolves.toBeNull();
});

it('clears completed progress and retains useful media checkpoints', async () => {
  expect(shouldSaveMediaProgress(0.5, 300)).toBe(false);
  expect(shouldSaveMediaProgress(42, 300)).toBe(true);
  expect(shouldSaveMediaProgress(291, 300)).toBe(false);

  await clearRemoteContentProgress(identity);
  expect(removeItem).toHaveBeenCalledWith(remoteContentProgressKey(identity));
});
