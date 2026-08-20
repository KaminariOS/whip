import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  REMOTE_GIT_PREFERENCES_KEY,
  REMOTE_GIT_TREE_PREFERENCES_KEY,
  loadRemoteGitCollapsedPaths,
  loadRemoteGitMode,
  saveRemoteGitCollapsedPaths,
  saveRemoteGitMode,
} from '../src/services/remoteGitPreferences';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const getItem = AsyncStorage.getItem as jest.MockedFunction<
  typeof AsyncStorage.getItem
>;
const setItem = AsyncStorage.setItem as jest.MockedFunction<
  typeof AsyncStorage.setItem
>;

beforeEach(() => {
  jest.clearAllMocks();
});

it('loads the mode only for the matching host and canonical repository root', async () => {
  getItem.mockResolvedValue(
    JSON.stringify([
      { hostId: 'host-a', root: '/repo', updatedAt: 2 },
      { hostId: 'host-b', root: '/other', updatedAt: 1 },
    ]),
  );

  await expect(loadRemoteGitMode('host-a', '/repo')).resolves.toBe(true);
  await expect(loadRemoteGitMode('host-a', '/other')).resolves.toBe(false);
  expect(getItem).toHaveBeenCalledWith(REMOTE_GIT_PREFERENCES_KEY);
});

it('falls back to disabled for malformed persisted data', async () => {
  getItem.mockResolvedValue('{broken');

  await expect(loadRemoteGitMode('host-a', '/repo')).resolves.toBe(false);
});

it('persists enabled repositories and removes disabled repositories', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1234);
  getItem
    .mockResolvedValueOnce(
      JSON.stringify([{ hostId: 'host-b', root: '/other', updatedAt: 2 }]),
    )
    .mockResolvedValueOnce(
      JSON.stringify([
        { hostId: 'host-a', root: '/repo', updatedAt: 3 },
        { hostId: 'host-b', root: '/other', updatedAt: 2 },
      ]),
    );

  await saveRemoteGitMode('host-a', '/repo', true);
  await saveRemoteGitMode('host-a', '/repo', false);

  expect(setItem).toHaveBeenNthCalledWith(
    1,
    REMOTE_GIT_PREFERENCES_KEY,
    JSON.stringify([
      { hostId: 'host-a', root: '/repo', updatedAt: 1234 },
      { hostId: 'host-b', root: '/other', updatedAt: 2 },
    ]),
  );
  expect(setItem).toHaveBeenNthCalledWith(
    2,
    REMOTE_GIT_PREFERENCES_KEY,
    JSON.stringify([{ hostId: 'host-b', root: '/other', updatedAt: 2 }]),
  );
  jest.restoreAllMocks();
});

it('persists collapsed directories per host and repository', async () => {
  getItem
    .mockResolvedValueOnce(
      JSON.stringify([
        {
          hostId: 'host-a',
          root: '/repo',
          collapsedPaths: ['src', 'packages/app'],
          updatedAt: 2,
        },
      ]),
    )
    .mockResolvedValueOnce('[]');

  await expect(loadRemoteGitCollapsedPaths('host-a', '/repo')).resolves.toEqual(
    ['src', 'packages/app'],
  );
  await saveRemoteGitCollapsedPaths('host-a', '/repo', ['src', 'src']);

  expect(getItem).toHaveBeenNthCalledWith(1, REMOTE_GIT_TREE_PREFERENCES_KEY);
  expect(setItem).toHaveBeenCalledWith(
    REMOTE_GIT_TREE_PREFERENCES_KEY,
    expect.stringContaining('"collapsedPaths":["src"]'),
  );
});
